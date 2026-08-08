/**
 * 上游调用执行 —— 流式与非流式的统一入口。
 *
 * 这一层只负责「向一个 provider 的一个 model 发起一次调用，并把结果写进响应」。
 * 选谁、重试谁、失败后怎么走，全部由 http/proxy 决定；这里不做任何路由判断。
 *
 * 响应写入权必须先通过 gate 抢占：并行竞速下多个调用可能同时成功，
 * 但只有第一个 claim 成功者可以写 HTTP 响应。
 */

import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type OpenAI from 'openai';
import { Readable } from 'node:stream';

import { ResponseClaimedError, type GateOwner, type ResponseGate } from '../core/gate';
import { createResponseEnvelope, type JsonRecord } from '../core/protocol';
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

export type ProxyProtocol = 'chat' | 'responses';

export interface InvokeContext {
  client: OpenAI;
  /** 已归一化为 Chat Completions 的上游请求体 */
  payload: Record<string, unknown>;
  /** 客户端原始 Responses 请求，用于构造兼容响应 */
  responseRequest?: JsonRecord;
  protocol: ProxyProtocol;
  model: string;
  res: Response;
  gate: ResponseGate;
  owner: GateOwner;
  /** 竞速窗口约束；parallel provider 超窗后不得抢占 */
  canClaim?: () => boolean;
  timeoutMs: number;
  /** 客户端断连时中止当前上游请求与流读取。 */
  clientSignal?: AbortSignal;
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
    ctx.clientSignal,
  );

  // 上游已返回，但响应权可能已被更快的竞争者拿走
  if (!claim(ctx)) throw new ResponseClaimedError();
  ctx.onFirstResponse?.();

  const body = response as unknown as {
    id?: string;
    created?: number;
    model?: string;
    choices?: Array<{
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
        reasoning?: string | null;
        tool_calls?: Array<JsonRecord>;
      };
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };

  if (ctx.protocol === 'responses') {
    const message = body.choices?.[0]?.message;
    ctx.res.json(
      createResponseEnvelope({
        request: ctx.responseRequest ?? {},
        model: body.model || ctx.model,
        content: message?.content ?? '',
        reasoningContent: message?.reasoning_content ?? message?.reasoning ?? undefined,
        toolCalls: message?.tool_calls,
        promptTokens: body.usage?.prompt_tokens,
        completionTokens: body.usage?.completion_tokens,
        reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens,
        id: body.id,
        createdAt: body.created,
      }),
    );
  } else {
    ctx.res.json(response);
  }

  return {
    actualModel: body.model || ctx.model,
    promptTokens: body.usage?.prompt_tokens ?? 0,
    completionTokens: body.usage?.completion_tokens ?? 0,
  };
}

function formatResponseEvent(event: JsonRecord): string {
  return `event: ${String(event.type ?? 'message')}\ndata: ${JSON.stringify(event)}\n\n`;
}

interface ResponseToolState {
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
  outputIndex: number;
}

/** Responses 流式格式由 Chat Completions chunk 增量转换，保持现有 Provider 兼容性。 */
async function invokeResponsesStream(ctx: InvokeContext): Promise<InvokeResult> {
  const responseId = `resp_${randomUUID().replace(/-/g, '')}`;
  const messageId = `msg_${responseId.slice(5)}`;
  const reasoningId = `rs_${responseId.slice(5)}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let sequence = 0;
  let opened = false;
  let messageOpened = false;
  let reasoningOpened = false;
  let nextOutputIndex = 0;
  let messageOutputIndex: number | null = null;
  let reasoningOutputIndex: number | null = null;
  let content = '';
  let reasoningContent = '';
  let actualModel = ctx.model;
  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  const tools = new Map<number, ResponseToolState>();

  const emit = (event: JsonRecord): void => {
    write(ctx.res, formatResponseEvent({ ...event, sequence_number: sequence++ }));
  };

  const ensureOpened = (): void => {
    if (opened) return;
    if (!claim(ctx)) throw new ResponseClaimedError();
    ctx.onFirstResponse?.();
    setStreamHeaders(ctx.res);
    opened = true;
    const response = {
      ...createResponseEnvelope({ request: ctx.responseRequest ?? {}, model: ctx.model, content: '', id: responseId, createdAt }),
      status: 'in_progress',
      output: [],
    };
    emit({ type: 'response.created', response });
    emit({ type: 'response.in_progress', response });
  };

  const ensureReasoning = (): number => {
    if (reasoningOutputIndex !== null) return reasoningOutputIndex;
    reasoningOpened = true;
    reasoningOutputIndex = nextOutputIndex++;
    emit({
      type: 'response.output_item.added',
      output_index: reasoningOutputIndex,
      item: { id: reasoningId, type: 'reasoning', status: 'in_progress', summary: [] },
    });
    return reasoningOutputIndex;
  };

  const ensureMessage = (): number => {
    if (messageOutputIndex !== null) return messageOutputIndex;
    messageOpened = true;
    messageOutputIndex = nextOutputIndex++;
    emit({
      type: 'response.output_item.added',
      output_index: messageOutputIndex,
      item: { id: messageId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    });
    emit({
      type: 'response.content_part.added',
      item_id: messageId,
      output_index: messageOutputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
    return messageOutputIndex;
  };

  const createStream = (payload: JsonRecord): Promise<unknown> =>
    withTimeout(
      (signal) => ctx.client.chat.completions.create(payload as never, { signal }),
      ctx.timeoutMs,
      `Model ${ctx.model} timed out after ${ctx.timeoutMs}ms`,
      ctx.clientSignal,
    );

  if (ctx.openEarly) ensureOpened();

  const base = { ...ctx.payload, model: ctx.model, stream: true };
  let upstream: unknown;
  try {
    upstream = await createStream({ ...base, stream_options: { include_usage: true } });
  } catch (error) {
    if (!isUnsupportedStreamOption(error)) throw error;
    upstream = await createStream(base);
  }

  const iterator = (upstream as AsyncIterable<JsonRecord>)[Symbol.asyncIterator]();
  for (;;) {
    const { value: chunk, done } = await readChunkWithTimeout(
      iterator,
      ctx.timeoutMs,
      `Model ${ctx.model} stalled for ${ctx.timeoutMs}ms`,
      ctx.clientSignal,
    );
    if (done) break;

    ensureOpened();
    if (typeof chunk.model === 'string' && chunk.model) actualModel = chunk.model;
    const usage = chunk.usage as
      | {
          prompt_tokens?: unknown;
          completion_tokens?: unknown;
          completion_tokens_details?: { reasoning_tokens?: unknown };
        }
      | undefined;
    if (usage) {
      const prompt = Number(usage.prompt_tokens);
      const completion = Number(usage.completion_tokens);
      const reasoning = Number(usage.completion_tokens_details?.reasoning_tokens);
      if (Number.isFinite(prompt)) promptTokens = prompt;
      if (Number.isFinite(completion)) completionTokens = completion;
      if (Number.isFinite(reasoning)) reasoningTokens = reasoning;
    }

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const first = choices[0];
    const delta = isJsonRecord(first) && isJsonRecord(first.delta) ? first.delta : {};
    const reasoningDelta =
      typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string'
          ? delta.reasoning
          : '';

    if (reasoningDelta) {
      const outputIndex = ensureReasoning();
      reasoningContent += reasoningDelta;
      emit({
        type: 'response.reasoning.delta',
        item_id: reasoningId,
        output_index: outputIndex,
        content_index: 0,
        delta: reasoningDelta,
      });
    }

    if (typeof delta.content === 'string' && delta.content) {
      const outputIndex = ensureMessage();
      content += delta.content;
      emit({
        type: 'response.output_text.delta',
        item_id: messageId,
        output_index: outputIndex,
        content_index: 0,
        delta: delta.content,
        logprobs: [],
      });
    }

    const toolDeltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const rawTool of toolDeltas) {
      if (!isJsonRecord(rawTool)) continue;
      const index = Number(rawTool.index ?? 0);
      const fn = isJsonRecord(rawTool.function) ? rawTool.function : {};
      let tool = tools.get(index);
      if (!tool) {
        tool = {
          itemId: String(rawTool.id ?? `fc_${randomUUID().replace(/-/g, '')}`),
          callId: String(rawTool.id ?? `call_${randomUUID().replace(/-/g, '')}`),
          name: String(fn.name ?? ''),
          arguments: '',
          outputIndex: nextOutputIndex++,
        };
        tools.set(index, tool);
        emit({
          type: 'response.output_item.added',
          output_index: tool.outputIndex,
          item: {
            id: tool.itemId,
            type: 'function_call',
            status: 'in_progress',
            call_id: tool.callId,
            name: tool.name,
            arguments: '',
          },
        });
      }
      if (typeof fn.name === 'string' && fn.name) tool.name = fn.name;
      const argumentDelta = typeof fn.arguments === 'string' ? fn.arguments : '';
      tool.arguments += argumentDelta;
      if (argumentDelta) {
        emit({
          type: 'response.function_call_arguments.delta',
          item_id: tool.itemId,
          output_index: tool.outputIndex,
          delta: argumentDelta,
        });
      }
    }
  }

  if (!opened) throw new Error(`Model ${ctx.model} returned an empty stream`);

  if (reasoningOpened && reasoningOutputIndex !== null) {
    emit({
      type: 'response.reasoning.done',
      item_id: reasoningId,
      output_index: reasoningOutputIndex,
      content_index: 0,
      text: reasoningContent,
    });
    emit({
      type: 'response.output_item.done',
      output_index: reasoningOutputIndex,
      item: {
        id: reasoningId,
        type: 'reasoning',
        status: 'completed',
        summary: [{ type: 'summary_text', text: reasoningContent }],
      },
    });
  }

  if (messageOpened && messageOutputIndex !== null) {
    const outputIndex = messageOutputIndex;
    emit({
      type: 'response.output_text.done',
      item_id: messageId,
      output_index: outputIndex,
      content_index: 0,
      text: content,
      logprobs: [],
    });
    emit({
      type: 'response.content_part.done',
      item_id: messageId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: content, annotations: [] },
    });
    emit({
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: {
        id: messageId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: content, annotations: [] }],
      },
    });
  }

  const toolCalls = [...tools.values()].map((tool) => ({
    id: tool.callId,
    type: 'function',
    function: { name: tool.name, arguments: tool.arguments },
  }));
  for (const tool of [...tools.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
    emit({
      type: 'response.function_call_arguments.done',
      item_id: tool.itemId,
      output_index: tool.outputIndex,
      arguments: tool.arguments,
    });
    emit({
      type: 'response.output_item.done',
      output_index: tool.outputIndex,
      item: {
        id: tool.itemId,
        type: 'function_call',
        status: 'completed',
        call_id: tool.callId,
        name: tool.name,
        arguments: tool.arguments,
      },
    });
  }

  const response = createResponseEnvelope({
    request: ctx.responseRequest ?? {},
    model: actualModel,
    content,
    reasoningContent: reasoningContent || undefined,
    toolCalls,
    promptTokens,
    completionTokens,
    reasoningTokens,
    id: responseId,
    createdAt,
  });
  emit({ type: 'response.completed', response });
  if (!ctx.res.writableEnded) ctx.res.end();

  return { actualModel, promptTokens, completionTokens };
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export async function invokeStream(ctx: InvokeContext): Promise<InvokeResult> {
  if (ctx.protocol === 'responses') return invokeResponsesStream(ctx);
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
      ctx.clientSignal,
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
        ctx.clientSignal,
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
        ctx.clientSignal,
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
export function writeStreamError(res: Response, message: string, protocol: ProxyProtocol = 'chat'): void {
  if (res.writableEnded) return;
  if (protocol === 'responses') {
    write(
      res,
      formatResponseEvent({
        type: 'response.failed',
        sequence_number: 0,
        response: { status: 'failed', error: { code: 'upstream_error', message } },
      }),
    );
    res.end();
    return;
  }
  write(res, formatSseData({ error: { message } }));
  write(res, SSE_DONE);
  res.end();
}