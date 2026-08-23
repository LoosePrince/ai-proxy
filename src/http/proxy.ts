/**
 * /v1/chat/completions —— 热路径。
 *
 * 关键性质：整个请求处理过程中对 Lsqlite 的往返次数为 **0**。
 *   - 配置读自 runtime/config-cache 的内存快照
 *   - 限流与轮转游标是内存计数器
 *   - 追溯记录入 runtime/write-queue，由后台批量事务落盘
 *
 * 旧实现每请求约 10 次数据库往返（其中 7 次写）。搬到远程 HTTP SQL 上
 * 会给每个 AI 请求叠加秒级延迟，因此这个改造不是优化而是可行性前提。
 *
 * 路由编排职责全在本文件：选谁、重试谁、失败后怎么走。
 * 具体的上游调用交给 upstream/invoke，排序决策交给 core/routing。
 */

import express, { type Request, type Response } from 'express';

import { createRaceWindow, createResponseGate, ResponseClaimedError, type ResponseGate } from '../core/gate';
import { normalizeChatPayload, responsesPayloadToChat, type JsonRecord } from '../core/protocol';
import { inspectRequest, keepOnlyUserMessages, stripClientSystemPrompts } from '../core/request-policy';
import { prependBuiltInSystemPrompt } from '../core/system-prompt';
import { createPublicContentEvent, createRequestCacheKey, parseCapturedBody } from '../core/request-content';
import {
  buildAttemptChain,
  buildModelCandidates,
  buildSpecialProviderChain,
  findSpecialProvider,
} from '../core/routing';
import { registerProxyRoutes, type ProxyProtocol } from './proxy-routes';
import { writeSyntheticSuccess } from './synthetic-response';
import { resolveTimeoutMs } from '../core/timeout';
import {
  createTrace,
  toRequestEvent,
  withAttempt,
  withFallbackTriggered,
  withFirstResponse,
  type Trace,
  type TraceOutcome,
} from '../core/trace';
import type { ProviderRecord } from '../db/repo/providers';
import { findReusableResponse, saveCachedResponse } from '../db/repo/response-cache';
import type { RequestContentInput } from '../db/repo/requests';
import { getConfig, type ConfigSnapshot } from '../runtime/config-cache';
import { checkRateLimit, rotationCursor } from '../runtime/counters';
import { publishPublicContent } from '../runtime/public-content-stream';
import { enqueueRequestEvent } from '../runtime/write-queue';
import { invokeProviderScript } from '../upstream/script';
import { getUpstreamClient } from '../upstream/client';
import { invokeUpstream, writeStreamError, type InvokeResult } from '../upstream/invoke';
import type { AttemptRole } from '../types/api';

const router = express.Router();

/** 单次 provider 尝试的结果。ok=false 时 error 一定存在。 */
interface AttemptResult {
  ok: boolean;
  provider: ProviderRecord;
  role: AttemptRole;
  result?: InvokeResult;
  error?: unknown;
  /** 响应已被写出（成功或已开流后失败），调用方不得再尝试其他 provider */
  responseSettled: boolean;
}

function normalizeIp(value: string): string {
  return value.replace(/^::ffff:/i, '');
}

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) {
    return normalizeIp(forwarded.split(',')[0]?.trim() || 'unknown');
  }
  return normalizeIp(req.ip || 'unknown');
}

function errorStatus(error: unknown): number {
  const candidate = error as { status?: number; response?: { status?: number } };
  return candidate?.status ?? candidate?.response?.status ?? 500;
}

function errorMessage(error: unknown): string {
  return (error as Error)?.message || 'Unknown error';
}

function errorCode(error: unknown): string | null {
  return (error as { code?: string })?.code ?? null;
}

class ClientDisconnectedError extends Error {
  readonly status = 499;
  readonly code = 'CLIENT_DISCONNECTED';

  constructor() {
    super('Client disconnected');
    this.name = 'ClientDisconnectedError';
  }
}

/**
 * 把一次失败归类成 client_abort 还是 upstream_error。
 *
 * 判定以 clientSignal 为准而不是只看错误类型：客户端断开后，上游调用往下
 * 抛出的往往是被 abort 连带触发的网络错误，而不是 ClientDisconnectedError 本身。
 * 如果只匹配错误类型，这些请求会被误记为上游故障。
 */
function failureOutcome(signal: AbortSignal, error: unknown): 'client_abort' | 'upstream_error' {
  if (signal.aborted) return 'client_abort';
  return error instanceof ClientDisconnectedError ? 'client_abort' : 'upstream_error';
}

/**
 * 对单个 provider 依次尝试其候选模型。
 *
 * trace 以不可变方式累积：每次尝试（含失败与被抢占）都记录下来。
 * 旧实现里中途重试失败只打 console.warn 就丢弃，无法追溯，这里全部入库。
 */
async function attemptProvider(args: {
  provider: ProviderRecord;
  role: AttemptRole;
  payload: JsonRecord;
  responseRequest?: JsonRecord;
  protocol: ProxyProtocol;
  res: Response;
  clientSignal: AbortSignal;
  config: ConfigSnapshot;
  gate: ResponseGate;
  canClaim?: () => boolean;
  stream: boolean;
  requestedModel: string | null;
  trace: Trace;
}): Promise<{ outcome: AttemptResult; trace: Trace }> {
  const {
    provider,
    role,
    payload,
    responseRequest,
    protocol,
    res,
    clientSignal,
    config,
    gate,
    canClaim,
    stream,
    requestedModel,
  } = args;
  let trace = args.trace;

  const timeoutMs = resolveTimeoutMs(provider, config.settings, config.groups);
  const groupRule = config.groups.get(provider.priority)?.rule ?? 'priority';
  const models = buildModelCandidates(
    provider,
    requestedModel,
    groupRule,
    rotationCursor,
    config.settings.maxModelRetryCount,
  );

  // provider 无可用模型：不发起调用，但仍留痕以便排查配置问题
  if (models.length === 0) {
    const now = Date.now();
    trace = withAttempt(trace, {
      role,
      providerId: provider.id,
      providerName: provider.name,
      priority: provider.priority,
      attemptedModel: null,
      timeoutMs,
      status: 'failed',
      errorMessage: 'provider has no usable model',
      startedAtMs: now,
      endedAtMs: now,
    });
    return {
      outcome: { ok: false, provider, role, error: new Error('provider has no usable model'), responseSettled: false },
      trace,
    };
  }

  const upstreamPayload = prependBuiltInSystemPrompt(
    payload,
    config.settings.globalSystemPromptEnabled ? config.settings.globalSystemPrompt : '',
    provider.systemPrompt,
  );
  const client = provider.requestMode === 'openai' ? getUpstreamClient(provider) : null;
  const owner = `${role}:${provider.id}`;
  let lastError: unknown = null;

  for (const model of models) {
    const startedAtMs = Date.now();

    try {
      const result =
        provider.requestMode === 'script'
          ? await invokeProviderScript({
              provider,
              request: { payload: upstreamPayload, model, signal: clientSignal },
              timeoutMs,
              res,
              gate,
              owner,
              canClaim,
            }).then((scriptResult) => {
              trace = withFirstResponse(trace);
              return {
                actualModel: scriptResult.actualModel,
                promptTokens: scriptResult.promptTokens,
                completionTokens: scriptResult.completionTokens,
                upstreamRequest: { ...upstreamPayload, model },
                capturedResponse: {
                  contentType: scriptResult.contentType,
                  body: typeof scriptResult.body === 'string' ? scriptResult.body : JSON.stringify(scriptResult.body),
                },
              };
            })
          : await invokeUpstream(
              {
                client: client!,
                payload: upstreamPayload,
                responseRequest,
                protocol,
                model,
                res,
                gate,
                owner,
                canClaim,
                timeoutMs,
                clientSignal,
                onFirstResponse: () => {
                  trace = withFirstResponse(trace);
                },
                openEarly: role === 'fallback' && stream,
              },
              stream,
            );

      trace = withAttempt(trace, {
        role,
        providerId: provider.id,
        providerName: provider.name,
        priority: provider.priority,
        attemptedModel: model,
        actualModel: result.actualModel,
        timeoutMs,
        status: 'success',
        startedAtMs,
      });

      return { outcome: { ok: true, provider, role, result, responseSettled: true }, trace };
    } catch (error) {
      lastError = error;

      // 被更快的 provider 抢占：不是故障，本次尝试就此终止
      if (error instanceof ResponseClaimedError) {
        trace = withAttempt(trace, {
          role,
          providerId: provider.id,
          providerName: provider.name,
          priority: provider.priority,
          attemptedModel: model,
          timeoutMs,
          status: 'claimed-by-other',
          errorMessage: errorMessage(error),
          startedAtMs,
        });
        return {
          outcome: { ok: false, provider, role, error, responseSettled: res.headersSent || res.writableEnded },
          trace,
        };
      }

      trace = withAttempt(trace, {
        role,
        providerId: provider.id,
        providerName: provider.name,
        priority: provider.priority,
        attemptedModel: model,
        timeoutMs,
        status: 'failed',
        errorMessage: errorMessage(error),
        startedAtMs,
      });

      if (clientSignal.aborted) {
        return { outcome: { ok: false, provider, role, error, responseSettled: true }, trace };
      }

      console.warn(
        `[Proxy] ${provider.name} (${model}) failed: status=${errorStatus(error)} timeout=${timeoutMs}ms ${errorMessage(error)}`,
      );

      /*
       * 已经开流后才失败：客户端已经收到了部分内容，无法再切换 provider。
       * 只能在流内补一个 error 帧并收尾。
       */
      if (res.headersSent && gate.isOwnedBy(owner)) {
        if (!res.writableEnded) writeStreamError(res, errorMessage(error), protocol);
        return { outcome: { ok: false, provider, role, error, responseSettled: true }, trace };
      }

      if (res.headersSent) {
        return { outcome: { ok: false, provider, role, error, responseSettled: true }, trace };
      }
    }
  }

  return { outcome: { ok: false, provider, role, error: lastError, responseSettled: false }, trace };
}

async function handleProxyRequest(
  req: Request,
  res: Response,
  protocol: ProxyProtocol,
): Promise<void> {
  const clientController = new AbortController();
  res.once('close', () => {
    if (!res.writableEnded) clientController.abort(new ClientDisconnectedError());
  });

  const originalPayload = (req.body ?? {}) as JsonRecord;
  const requestedModel = typeof originalPayload.model === 'string' ? originalPayload.model : null;
  const stream = originalPayload.stream === true;
  let payload =
    protocol === 'responses' ? responsesPayloadToChat(originalPayload) : normalizeChatPayload(originalPayload);
  const ip = getClientIp(req);

  let trace = createTrace({ requestedModel, stream, ip });
  let contentLoggingEnabled = false;
  let publicContentStreamEnabled = false;

  /** 唯一的落盘出口；正文持久化与公开脱敏发布是互相独立的消费者。 */
  const finish = (outcome: TraceOutcome, content?: RequestContentInput) => {
    const snapshot: RequestContentInput = content ?? {
      clientRequest: originalPayload,
      upstreamRequest: null,
      aiResponse: outcome.errorMessage ? { error: outcome.errorMessage, code: outcome.errorCode ?? null } : null,
    };
    const event = toRequestEvent(trace, outcome);
    if (contentLoggingEnabled && outcome.outcome !== 'cache_hit') event.content = snapshot;
    enqueueRequestEvent(event);

    if (publicContentStreamEnabled) {
      publishPublicContent(
        createPublicContentEvent({
          id: trace.traceId,
          occurredAt: event.completedAt,
          protocol,
          stream,
          model: outcome.finalModel ?? requestedModel,
          request: snapshot.clientRequest,
          response: snapshot.aiResponse,
        }),
      );
    }
  };

  let config: ConfigSnapshot;
  try {
    config = await getConfig();
  } catch (error) {
    // 配置不可用时无法路由，此时也无法保证能落盘，直接返回
    res.status(503).json({ error: { message: `Configuration unavailable: ${errorMessage(error)}` } });
    return;
  }

  const { settings } = config;
  contentLoggingEnabled = settings.requestContentLoggingEnabled;
  publicContentStreamEnabled = settings.publicRequestContentStreamEnabled;

  if (config.blacklistedIps.has(ip)) {
    const message = '该 IP 已被禁止访问';
    finish({ outcome: 'rejected', httpStatus: 403, errorCode: 'ip_blacklisted', errorMessage: message });
    res.status(403).json({ error: { message, type: 'ip_blacklisted' } });
    return;
  }

  const respondLocally = (content: string, reason: 'ide_request' | 'malicious_request'): void => {
    trace = withFirstResponse(trace);
    const synthetic = writeSyntheticSuccess(
      res,
      protocol,
      originalPayload,
      requestedModel ?? 'ai-proxy-policy',
      stream,
      content,
    );
    finish(
      {
        outcome: 'rejected',
        httpStatus: 200,
        finalModel: requestedModel,
      },
      {
        clientRequest: originalPayload,
        upstreamRequest: { forwarded: false, handledBy: reason },
        aiResponse: synthetic.responseBody,
      },
    );
  };

  const rejectByPolicy = (code: string, message: string): void => {
    finish({ outcome: 'rejected', httpStatus: 403, errorCode: code, errorMessage: message });
    res.status(403).json({ error: { message, code } });
  };

  const inspection =
    settings.ideRequestHandlingEnabled || settings.maliciousRequestHandlingEnabled
      ? inspectRequest(payload)
      : { isIdeRequest: false, isMalicious: false };
  if (settings.maliciousRequestHandlingEnabled && inspection.isMalicious) {
    if (settings.maliciousRequestAction === 'error') {
      rejectByPolicy('malicious_request_blocked', '请求包含被安全策略拒绝的内容');
      return;
    }
    respondLocally(
      settings.maliciousRequestAction === 'response' ? settings.maliciousResponse : '',
      'malicious_request',
    );
    return;
  }

  if (settings.ideRequestHandlingEnabled && inspection.isIdeRequest) {
    if (settings.ideRequestAction === 'error') {
      rejectByPolicy('ide_request_blocked', '检测到来自 IDE 环境或工具链的请求');
      return;
    }
    if (settings.ideRequestAction === 'ignore') {
      respondLocally('', 'ide_request');
      return;
    }
    payload =
      settings.ideRequestAction === 'only-user-messages'
        ? keepOnlyUserMessages(payload)
        : stripClientSystemPrompts(payload);
  }

  // ---- 限流（内存滑动窗口，阈值来自配置快照）----
  const rate = checkRateLimit(ip, settings.ipRateLimitRpm);
  if (rate.limit > 0) {
    res.setHeader('X-RateLimit-Limit', String(rate.limit));
    res.setHeader('X-RateLimit-Remaining', String(rate.remaining ?? 0));
  }
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSec));
    const message = `请求过于频繁，同 IP 每分钟最多 ${rate.limit} 次请求，请 ${rate.retryAfterSec} 秒后重试`;
    finish({ outcome: 'rejected', httpStatus: 429, errorCode: 'rate_limit_exceeded', errorMessage: message });
    res.status(429).json({ error: { message, type: 'rate_limit_exceeded' } });
    return;
  }

  const cachePayload = {
    ...payload,
    __aiProxyPolicy: {
      globalSystemPrompt: settings.globalSystemPromptEnabled ? settings.globalSystemPrompt : '',
      providerSystemPrompts: config.providers
        .filter((provider) => provider.enabled && provider.systemPrompt)
        .map((provider) => [provider.id, provider.systemPrompt]),
      providerRequestLogic: config.providers
        .filter((provider) => provider.enabled)
        .map((provider) => [provider.id, provider.requestMode, provider.requestScript, provider.variables]),
    },
  };
  const cacheKey = settings.requestCacheEnabled ? createRequestCacheKey(protocol, cachePayload) : null;
  if (cacheKey) {
    try {
      const cached = await findReusableResponse(cacheKey, settings.requestCacheReuseHours);
      if (cached) {
        trace = withFirstResponse(trace);
        res.status(200);
        res.setHeader('Content-Type', cached.contentType);
        res.setHeader('X-AI-Proxy-Cache', 'HIT');
        if (cached.stream) {
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.setHeader('X-Accel-Buffering', 'no');
        }
        res.end(cached.responseBody);

        finish(
          {
            outcome: 'cache_hit',
            cacheKey,
            httpStatus: 200,
            finalProviderId: cached.finalProviderId,
            finalProviderName: cached.finalProviderName,
            finalRole: cached.finalRole,
            finalModel: cached.actualModel,
            promptTokens: cached.promptTokens,
            completionTokens: cached.completionTokens,
          },
          {
            clientRequest: originalPayload,
            upstreamRequest: { cacheHit: true, cacheCreatedAt: cached.createdAt },
            aiResponse: parseCapturedBody(cached.responseBody, cached.contentType),
          },
        );
        return;
      }
    } catch (error) {
      console.warn(`[Cache] lookup failed, continuing without cache: ${errorMessage(error)}`);
    }
  }

  // ---- 构建尝试链 ----
  const chain = buildAttemptChain(
    config.providers,
    config.groups,
    requestedModel,
    settings.globalRule,
    rotationCursor,
  ).slice(0, settings.maxPrimaryAttempts);

  const parallelProvider = findSpecialProvider(config.providers, 'parallel');
  const fallbackChain = buildSpecialProviderChain(
    config.providers,
    config.groups,
    'fallback',
    settings.globalRule,
    rotationCursor,
  );

  if (chain.length === 0 && !parallelProvider && fallbackChain.length === 0) {
    const message = 'No available AI providers configured';
    finish({ outcome: 'upstream_error', httpStatus: 503, errorCode: 'no_provider', errorMessage: message });
    res.status(503).json({ error: { message } });
    return;
  }

  const gate = createResponseGate();
  let lastError: unknown = null;

  const run = async (provider: ProviderRecord, role: AttemptRole, canClaim?: () => boolean) => {
    const { outcome, trace: nextTrace } = await attemptProvider({
      provider,
      role,
      payload,
      responseRequest: protocol === 'responses' ? originalPayload : undefined,
      protocol,
      res,
      clientSignal: clientController.signal,
      config,
      gate,
      canClaim,
      stream,
      requestedModel,
      trace,
    });
    trace = nextTrace;
    if (!outcome.ok) lastError = outcome.error ?? lastError;
    return outcome;
  };

  const succeed = async (outcome: AttemptResult): Promise<void> => {
    const result = outcome.result;
    const content = result
      ? {
          clientRequest: originalPayload,
          upstreamRequest: result.upstreamRequest,
          aiResponse: parseCapturedBody(result.capturedResponse.body, result.capturedResponse.contentType),
        }
      : undefined;

    finish(
      {
        outcome: 'upstream_ok',
        httpStatus: 200,
        finalProviderId: outcome.provider.id,
        finalProviderName: outcome.provider.name,
        finalRole: outcome.role,
        finalModel: result?.actualModel ?? null,
        promptTokens: result?.promptTokens ?? 0,
        completionTokens: result?.completionTokens ?? 0,
      },
      content,
    );

    if (cacheKey && result) {
      try {
        await saveCachedResponse({
          cacheKey,
          protocol,
          stream,
          requestedModel,
          contentType: result.capturedResponse.contentType,
          responseBody: result.capturedResponse.body,
          actualModel: result.actualModel,
          finalProviderId: outcome.provider.id,
          finalProviderName: outcome.provider.name,
          finalRole: outcome.role,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          clientRequestBody: contentLoggingEnabled ? JSON.stringify(originalPayload) : null,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        console.warn(`[Cache] response was served but cache write failed: ${errorMessage(error)}`);
      }
    }
  };

  /*
   * parallel provider 竞速：与主链首个 provider 同时发起，谁先拿到响应权谁写。
   * 它受竞速窗口约束 —— 超窗后即使先返回也不得抢占，避免慢速旁路拖累整体延迟。
   */
  const raceWindow = parallelProvider ? createRaceWindow(settings.parallelTimeoutMs) : null;
  const parallelAttempt =
    parallelProvider && raceWindow
      ? run(parallelProvider, 'parallel', chain.length > 0 ? raceWindow : undefined).catch(
          (error): AttemptResult => ({
            ok: false,
            provider: parallelProvider,
            role: 'parallel',
            error,
            responseSettled: false,
          }),
        )
      : null;

  // ---- 主链：按序尝试 ----
  for (const provider of chain) {
    if (res.headersSent || res.writableEnded) break;

    const outcome = await run(provider, 'primary');
    if (outcome.ok) {
      await succeed(outcome);
      return;
    }
    if (outcome.responseSettled) {
      const failure = failureOutcome(clientController.signal, outcome.error);
      /*
       * 客户端自己断开时不把 provider 记为责任方：它会被写进 provider_usage_daily，
       * 让一个正常工作的上游看起来在失败。归属只在真正的上游故障时才建立。
       */
      const attribution =
        failure === 'client_abort'
          ? {}
          : {
              finalProviderId: outcome.provider.id,
              finalProviderName: outcome.provider.name,
              finalRole: outcome.role,
            };

      finish({
        outcome: failure,
        httpStatus: errorStatus(outcome.error),
        errorCode: errorCode(outcome.error),
        errorMessage: errorMessage(outcome.error),
        ...attribution,
      });
      return;
    }
  }

  // 主链跑完仍未出结果时，等一下并行旁路的最终结果
  if (parallelAttempt) {
    const outcome = await parallelAttempt;
    if (outcome.ok) {
      await succeed(outcome);
      return;
    }
    if (res.headersSent || res.writableEnded) {
      finish({
        outcome: failureOutcome(clientController.signal, outcome.error),
        httpStatus: errorStatus(outcome.error),
        errorCode: errorCode(outcome.error),
        errorMessage: errorMessage(outcome.error),
      });
      return;
    }
  }

  // ---- 保底链：主链全败后按路由规则逐个失败转移 ----
  if (fallbackChain.length > 0 && !res.headersSent) {
    trace = withFallbackTriggered(trace);
    for (const provider of fallbackChain) {
      if (res.headersSent || res.writableEnded) break;

      const outcome = await run(provider, 'fallback');
      if (outcome.ok) {
        await succeed(outcome);
        return;
      }
      if (outcome.responseSettled) break;
    }
  }

  if (res.writableEnded) {
    finish({
      outcome: failureOutcome(clientController.signal, lastError),
      httpStatus: errorStatus(lastError),
      errorCode: errorCode(lastError),
      errorMessage: errorMessage(lastError),
    });
    return;
  }

  const status = errorStatus(lastError);
  const message = lastError ? errorMessage(lastError) : 'All providers failed';
  finish({
    outcome: failureOutcome(clientController.signal, lastError),
    httpStatus: status,
    errorCode: errorCode(lastError),
    errorMessage: message,
  });

  if (res.headersSent) {
    if (!res.writableEnded) writeStreamError(res, message, protocol);
    return;
  }
  res.status(status).json({ error: { message } });
}

registerProxyRoutes(router, handleProxyRequest);

/** GET /models —— 汇总所有启用 provider 声明的模型，OpenAI 兼容格式 */
async function listModels(_req: Request, res: Response): Promise<void> {
  try {
    const config = await getConfig();
    const models = new Set<string>();
    for (const provider of config.providers) {
      if (!provider.enabled) continue;
      for (const model of provider.models) models.add(model);
    }

    res.json({
      object: 'list',
      data: [...models].sort().map((id) => ({ id, object: 'model', owned_by: 'ai-proxy' })),
    });
  } catch (error) {
    res.status(503).json({ error: { message: errorMessage(error) } });
  }
}

for (const path of ['/v1/models', '/models']) router.get(path, (req, res) => void listModels(req, res));

export default router;