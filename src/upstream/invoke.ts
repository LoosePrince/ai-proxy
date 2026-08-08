/**
 * 上游调用执行 —— 流式与非流式的统一入口。
 *
 * 这一层只负责「向一个 provider 的一个 model 发起一次调用，并把结果写进响应」。
 * 选谁、重试谁、失败后怎么走，全部由 http/proxy 决定；这里不做任何路由判断。
 *
 * 响应写入权必须先通过 gate 抢占：并行竞速下多个调用可能同时成功，
 * 但只有第一个 claim 成功者可以写 HTTP 响应。
 */

import type { Response } from 'express';
import type OpenAI from 'openai';
import { Readable } from 'node:stream';

import { ResponseClaimedError, type GateOwner, type ResponseGate } from '../core/gate';
import { readChunkWithTimeout, withTimeout } from '../core/timeout';
import {
  SSE_DONE,
  createScanState,
  formatSseData,
  isUnsupportedStreamOption,
  scanText,
  type SseScanState,
} from './sse';

/** 一次成功调用的产出，供 trace 与聚合统计使用 */
export interface InvokeResult {
  actualModel: string;
  promptTokens: number;
  completionTokens: number;
}

export interface InvokeContext {
  client: OpenAI;
  /** 客户端原始请求体，仅覆盖 model 字段后转发 */
  payload: Record<string, unknown>;
  model: string;
  res: Response;
  gate: ResponseGate;
  owner: GateOwner;
  /** 竞速窗口约束；parallel provider 超窗后不得抢占 */
  canClaim?: () => boolean;
  timeoutMs: number;
  /** 首次写响应时回调，用于记录 TTFB */
  onFirstResponse?: () => void;
  /**
   * 保底 provider 提前开流：先占住响应权并发一个空 delta，
   * 避免客户端在漫长的重试链之后已经超时断开。
   */
  openEarly?: boolean;
}

function setStreamHeaders(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // 关键：禁止反向代理缓冲，否则流式会被攒成一整块
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

function write(res: Response, chunk: string): void {
  res.write(chunk);
  (res as Response & { flush?: () => void }).flush?.();
}

/** 抢占响应写入权；已被他人占用或超出竞速窗口则失败 */
function claim(ctx: InvokeContext): boolean {
  if (ctx.res.headersSent || ctx.res.writableEnded) return false;
  return ctx.gate.claim(ctx.owner, ctx.canClaim);
}

/**
 * 取上游原始字节流。
 * 能拿到就原样透传，保留上游的分片节奏与自带的 [DONE]；
 * 拿不到则退回 SDK 迭代器重新序列化。
 */
function extractRawStream(upstream: unknown): Readable | null {
  const body = (upstream as { controller?: { response?: { body?: unknown } } })?.controller?.response?.body;
  if (!body) return null;
  if (typeof (body as ReadableStream).getReader === 'function') {
    return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  }
  if (typeof (body as Readable).on === 'function') return body as Readable;
  return null;
}

export async function invokeNonStream(ctx: InvokeContext): Promise<InvokeResult> {
  const response = await withTimeout(
    (signal) =>
      ctx.client.chat.completions.create(
        { ...ctx.payload, model: ctx.model, stream: false } as never,
        { signal },
      ),
    ctx.timeoutMs,
    `Model ${ctx.model} timed out after ${ctx.timeoutMs}ms`,
  );

  // 上游已返回，但响应权可能已被更快的竞争者拿走
  if (!claim(ctx)) throw new ResponseClaimedError();
  ctx.onFirstResponse?.();

  const body = response as unknown as {
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  ctx.res.json(response);

  return {
    actualModel: body.model || ctx.model,
    promptTokens: body.usage?.prompt_tokens ?? 0,
    completionTokens: body.usage?.completion_tokens ?? 0,
  };
}

export async function invokeStream(ctx: InvokeContext): Promise<InvokeResult> {
  let headersOpened = false;
  let state: SseScanState = createScanState();

  const ensureOpened = (): void => {
    if (headersOpened) return;
    if (!claim(ctx)) throw new ResponseClaimedError();
    ctx.onFirstResponse?.();
    setStreamHeaders(ctx.res);
    headersOpened = true;
  };

  const createStream = (payload: Record<string, unknown>): Promise<unknown> =>
    withTimeout(
      (signal) => ctx.client.chat.completions.create(payload as never, { signal }),
      ctx.timeoutMs,
      `Model ${ctx.model} timed out after ${ctx.timeoutMs}ms`,
    );

  if (ctx.openEarly) {
    ensureOpened();
    write(
      ctx.res,
      formatSseData({
        id: 'ai-proxy-warmup',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: ctx.model,
        choices: [{ index: 0, delta: {}, finish_reason: null }],
      }),
    );
  }

  const base = { ...ctx.payload, model: ctx.model, stream: true };
  let upstream: unknown;
  try {
    // 优先索取 usage，拿不到才降级 —— 否则 token 统计会缺失
    upstream = await createStream({ ...base, stream_options: { include_usage: true } });
  } catch (error) {
    if (!isUnsupportedStreamOption(error)) throw error;
    upstream = await createStream(base);
  }

  const rawStream = extractRawStream(upstream);

  if (rawStream) {
    const iterator = rawStream[Symbol.asyncIterator]();

    for (;;) {
      const { value, done } = await readChunkWithTimeout(
        iterator,
        ctx.timeoutMs,
        `Model ${ctx.model} stalled for ${ctx.timeoutMs}ms`,
      );
      if (done) break;

      ensureOpened();
      const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
      write(ctx.res, text);
      state = scanText(state, text);
    }
  } else {
    const iterator = (upstream as AsyncIterable<Record<string, unknown>>)[Symbol.asyncIterator]();

    for (;;) {
      const { value: chunk, done } = await readChunkWithTimeout(
        iterator,
        ctx.timeoutMs,
        `Model ${ctx.model} stalled for ${ctx.timeoutMs}ms`,
      );
      if (done) break;

      ensureOpened();
      state = scanText(state, formatSseData(chunk));
      write(ctx.res, formatSseData(chunk));
    }

    // SDK 迭代器路径不带 [DONE]，需要补上
    if (headersOpened) write(ctx.res, SSE_DONE);
  }

  // 上游一个 chunk 都没给：视为失败，让调用方继续尝试下一个 provider
  if (!headersOpened) {
    throw new Error(`Model ${ctx.model} returned an empty stream`);
  }

  if (!ctx.res.writableEnded) ctx.res.end();

  return {
    actualModel: state.actualModel || ctx.model,
    promptTokens: state.promptTokens,
    completionTokens: state.completionTokens,
  };
}

/** 流式 / 非流式的统一分派 */
export function invokeUpstream(ctx: InvokeContext, stream: boolean): Promise<InvokeResult> {
  return stream ? invokeStream(ctx) : invokeNonStream(ctx);
}

/** 已开流后才失败：只能在流内写错误帧收尾，HTTP 状态码已无法更改 */
export function writeStreamError(res: Response, message: string): void {
  if (res.writableEnded) return;
  write(res, formatSseData({ error: { message } }));
  write(res, SSE_DONE);
  res.end();
}