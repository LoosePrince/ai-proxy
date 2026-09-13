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

import express, { type Request, type RequestHandler, type Response } from 'express';

import { createRaceWindow, createResponseGate, ResponseClaimedError, type ResponseGate } from '../core/gate';
import { normalizeChatPayload, responsesPayloadToChat, type JsonRecord } from '../core/protocol';
import {
  inspectRequest,
  keepOnlyUserMessages,
  parseForbiddenKeywords,
  stripClientSystemPrompts,
} from '../core/request-policy';
import { prependBuiltInSystemPrompt } from '../core/system-prompt';
import { evaluateText } from '../core/moderation/evaluate';
import { resolveModerationPolicy } from '../core/moderation/compile';
import type { CompiledModerationPolicy } from '../core/moderation/types';
import {
  payloadUserText,
  responseText as extractResponseText,
  responseTextIsEmpty,
} from '../core/moderation/text';
import { createPublicContentEvent, createRequestCacheKey, parseCapturedBody } from '../core/request-content';
import {
  buildAttemptChain,
  buildModelCandidates,
  buildSpecialProviderChain,
  findSpecialProvider,
  type ModelHealthProbe,
} from '../core/routing';
import {
  isModelCoolingDown,
  modelHealthStatus,
  recordModelAttempt,
} from '../runtime/model-health';
import { PROXY_ROUTES, registerProxyRoutes, type ProxyProtocol } from './proxy-routes';
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
import { addIpBlacklist } from '../db/repo/ip-blacklist';
import { getConfig, invalidateConfig, peekConfig, type ConfigSnapshot } from '../runtime/config-cache';
import {
  blockIpTemporarily,
  checkRateLimit,
  rotationCursor,
  temporaryBlockRemainingSec,
  temporaryThrottleRemainingSec,
  throttleIpTemporarily,
  type RateLimitRule,
} from '../runtime/counters';
import { publishPublicContent } from '../runtime/public-content-stream';
import { enqueueRequestEvent } from '../runtime/write-queue';
import { invokeProviderScript } from '../upstream/script';
import { getUpstreamClient } from '../upstream/client';
import { invokeUpstream, writeStreamError, type InvokeResult } from '../upstream/invoke';
import type { AttemptRole, MaliciousBehaviorAction, SettingsDTO } from '../types/api';
import type { ModerationEventInput } from '../db/repo/requests';

const router = express.Router();

/** 审核判定 → 待落盘的审计事件 */
function toModerationEvent(
  decision: { stage: 'input' | 'output'; categories: string[]; detectorIds: string[]; score: number; matched: string[]; action: string; blocked: boolean; policyId: number | null; policyName: string },
  providerName: string | null,
  model: string | null,
): ModerationEventInput {
  return {
    occurredAt: new Date().toISOString(),
    stage: decision.stage,
    categories: decision.categories,
    detectorIds: decision.detectorIds,
    score: decision.score,
    matched: decision.matched,
    action: decision.action,
    blocked: decision.blocked,
    policyId: decision.policyId,
    policyName: decision.policyName || null,
    providerName,
    model,
  };
}

/** 输出侧生效策略：总开关 / 输出开关都打开时，按 Provider→模型作用域解析 */
function resolveOutputModeration(
  config: ConfigSnapshot,
  providerId: number | null,
  model: string | null,
): CompiledModerationPolicy | null {
  const { settings } = config;
  if (!settings.moderationEnabled || !settings.moderationOutputEnabled) return null;
  return resolveModerationPolicy(config.moderation, providerId, model);
}

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

/**
 * 从 settings 编译多窗口限流规则。任一窗口超限即拒绝，多个上限同时生效。
 * 0 / 缺省值表示该窗口不启用。
 */
function rateLimitRules(settings: SettingsDTO): RateLimitRule[] {
  const rules: RateLimitRule[] = [];
  if (settings.ipRateLimitRpm > 0) rules.push({ windowMs: 60_000, limit: settings.ipRateLimitRpm, label: '每分钟' });
  if (settings.ipRateLimitPer10Min > 0) {
    rules.push({ windowMs: 600_000, limit: settings.ipRateLimitPer10Min, label: '每 10 分钟' });
  }
  if (settings.ipRateLimitPer30Min > 0) {
    rules.push({ windowMs: 1_800_000, limit: settings.ipRateLimitPer30Min, label: '每 30 分钟' });
  }
  if (settings.ipRateLimitHours > 0 && settings.ipRateLimitPerXHours > 0) {
    rules.push({
      windowMs: settings.ipRateLimitHours * 3_600_000,
      limit: settings.ipRateLimitPerXHours,
      label: `每 ${settings.ipRateLimitHours} 小时`,
    });
  }
  return rules;
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
 * 渠道声明模型的实时健康探针（供路由排序与冷却过滤）。
 * 全部读自内存，零 IO。
 */
function modelHealthProbe(config: ConfigSnapshot, providerId: number): (model: string) => ModelHealthProbe {
  const settings = config.settings;
  return (model: string): ModelHealthProbe => {
    const status = modelHealthStatus(providerId, model, {
      modelCooldownFailureThreshold: settings.modelCooldownFailureThreshold,
      modelCooldownMinutes: settings.modelCooldownMinutes,
    });
    return { state: status.state, coolingDown: isModelCoolingDown(providerId, model) };
  };
}

/**
 * 上游调用失败后的副作用：计入模型健康窗口与冷却。
 * 只对真实打到上游的失败生效；被抢占（claimed-by-other）与客户端中断不算。
 */
function recordModelFailure(config: ConfigSnapshot, providerId: number, model: string): void {
  recordModelAttempt(providerId, model, false, {
    modelCooldownFailureThreshold: config.settings.modelCooldownFailureThreshold,
    modelCooldownMinutes: config.settings.modelCooldownMinutes,
  });
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
    config.settings.fuzzyModelMatchingEnabled,
    {
      mode: config.settings.modelHealthRoutingMode,
      healthOf: modelHealthProbe(config, provider.id),
    },
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
                // 输出审核按 Provider→模型作用域解析，命中由 invoke 层执行
                outputModeration: resolveOutputModeration(config, provider.id, model),
                moderationStream: config.settings.moderationOutputStreamEnabled,
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

      // 「返回空消息也视为失败」：响应已写出，无法再换模型；
      // 这里只做健康/冷却记账，让该模型尽快退出候选。
      if (
        config.settings.modelEmptyResponseCountsAsFailure &&
        responseTextIsEmpty(result.capturedResponse.body, result.capturedResponse.contentType)
      ) {
        recordModelFailure(config, provider.id, model);
      } else {
        recordModelAttempt(provider.id, model, true, {
          modelCooldownFailureThreshold: config.settings.modelCooldownFailureThreshold,
          modelCooldownMinutes: config.settings.modelCooldownMinutes,
        });
      }

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

      // 真实打到上游的失败：计入模型健康窗口与冷却计数
      recordModelFailure(config, provider.id, model);

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
  /** 本次请求产生的审核审计事件，随请求明细同批落盘 */
  const moderationEvents: ModerationEventInput[] = [];

  /** 唯一的落盘出口；正文持久化与公开脱敏发布是互相独立的消费者。 */
  const finish = (outcome: TraceOutcome, content?: RequestContentInput) => {
    const snapshot: RequestContentInput = content ?? {
      clientRequest: originalPayload,
      upstreamRequest: null,
      aiResponse: outcome.errorMessage ? { error: outcome.errorMessage, code: outcome.errorCode ?? null } : null,
    };
    const event = toRequestEvent(trace, outcome);
    if (contentLoggingEnabled && outcome.outcome !== 'cache_hit') event.content = snapshot;
    if (moderationEvents.length > 0) event.moderationEvents = moderationEvents;
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

  const respondLocally = (content: string, reason: 'ide_request' | 'malicious_request' | 'moderation_request'): void => {
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

  /*
   * ---- 多层内容审核：请求侧
   *
   * 输入是 Provider 无关的，因此固定使用全局默认策略；Provider / 模型级绑定
   * 作用于输出侧（那里才能确定 provider 与实际模型）。这与「层级」的定义一致。
   */
  if (settings.moderationEnabled && settings.moderationInputEnabled) {
    const inputPolicy = resolveModerationPolicy(config.moderation, null, null);
    if (inputPolicy) {
      const decision = evaluateText(payloadUserText(payload), inputPolicy, 'input');
      if (decision.blocked) {
        moderationEvents.push(toModerationEvent(decision, null, requestedModel));
        const action = decision.action as MaliciousBehaviorAction;
        const policyMessage = decision.action === 'response' ? inputPolicy.response : '';

        // ban / block / throttle 是 IP 级动作：本次拒绝，后续流量在网关层拦截
        if (action === 'ban' || action === 'block' || action === 'throttle') {
          if (ip && ip !== 'unknown') {
            if (action === 'ban') {
              try {
                await addIpBlacklist(ip, '触发内容审核策略，自动封禁');
              } catch (error) {
                console.warn(`[Proxy] 审核自动封禁写入失败: ${errorMessage(error)}`);
              }
              invalidateConfig();
            } else if (action === 'block') {
              blockIpTemporarily(ip, settings.maliciousThrottleMinutes);
            } else {
              throttleIpTemporarily(ip, settings.maliciousThrottleMinutes);
            }
          }
          const message = settings.blockedErrorMessage;
          const status = action === 'throttle' ? 429 : 403;
          const code = action === 'ban' ? 'ip_blacklisted' : action === 'block' ? 'ip_blocked' : 'ip_throttled';
          if (status === 429) {
            res.setHeader('Retry-After', String(Math.max(1, settings.maliciousThrottleMinutes * 60)));
          }
          finish({ outcome: 'rejected', httpStatus: status, errorCode: code, errorMessage: message });
          res.status(status).json({ error: { message, code } });
          return;
        }

        if (action === 'error') {
          rejectByPolicy('moderation_blocked', '请求包含被内容审核策略拦截的内容');
          return;
        }

        // empty（空回复）与 response（返回指定响应内容）
        respondLocally(policyMessage, 'moderation_request');
        return;
      }
    }
  }

  const inspection =
    settings.ideRequestHandlingEnabled || settings.maliciousRequestHandlingEnabled
      ? inspectRequest(payload, { customKeywords: parseForbiddenKeywords(settings.forbiddenKeywords) })
      : { isIdeRequest: false, isMalicious: false };
  if (settings.maliciousRequestHandlingEnabled && inspection.isMalicious) {
    const action = settings.maliciousRequestAction;

    // 封禁 / 拦截 / 限流是 IP 级动作：本次请求直接拒绝，后续流量在网关层拦截
    if (action === 'ban') {
      if (ip && ip !== 'unknown') {
        try {
          await addIpBlacklist(ip, '触发违禁内容策略，自动封禁');
        } catch (error) {
          console.warn(`[Proxy] 自动封禁写入失败: ${errorMessage(error)}`);
        }
        invalidateConfig();
      }
      const message = settings.blockedErrorMessage;
      finish({ outcome: 'rejected', httpStatus: 403, errorCode: 'ip_blacklisted', errorMessage: message });
      res.status(403).json({ error: { message, code: 'ip_blacklisted' } });
      return;
    }

    if (action === 'block') {
      if (ip && ip !== 'unknown') blockIpTemporarily(ip, settings.maliciousThrottleMinutes);
      const message = settings.blockedErrorMessage;
      finish({ outcome: 'rejected', httpStatus: 403, errorCode: 'ip_blocked', errorMessage: message });
      res.status(403).json({ error: { message, code: 'ip_blocked' } });
      return;
    }

    if (action === 'throttle') {
      if (ip && ip !== 'unknown') throttleIpTemporarily(ip, settings.maliciousThrottleMinutes);
      const message = settings.blockedErrorMessage;
      const retryAfterSec = Math.max(1, settings.maliciousThrottleMinutes * 60);
      res.setHeader('Retry-After', String(retryAfterSec));
      finish({ outcome: 'rejected', httpStatus: 429, errorCode: 'ip_throttled', errorMessage: message });
      res.status(429).json({ error: { message, code: 'ip_throttled' } });
      return;
    }

    if (action === 'error') {
      rejectByPolicy('malicious_request_blocked', '请求包含被安全策略拒绝的内容');
      return;
    }

    // empty（空回复）与 response（返回指定响应内容）
    respondLocally(action === 'response' ? settings.maliciousResponse : '', 'malicious_request');
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

  // ---- 限流已前移到 gatewayGuard：黑名单、临时拦截/限流与多窗口限流
  // 都在 body 解析前统一拦截，命中时请求体根本不会被读取。

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
        /*
         * 缓存命中也要重跑输出审核：缓存可能是旧策略下写入的，
         * 直接回放会让新策略被绕过。缓存正文是字符串，重判成本极低。
         */
        const cachedPolicy = resolveOutputModeration(config, cached.finalProviderId, cached.actualModel);
        if (cachedPolicy) {
          const cachedBody = parseCapturedBody(cached.responseBody, cached.contentType);
          const decision = evaluateText(extractResponseText(cachedBody), cachedPolicy, 'output');
          if (decision.blocked) {
            moderationEvents.push(
              toModerationEvent(decision, cached.finalProviderName, cached.actualModel),
            );
            const blockedMessage = '模型输出被内容审核策略拦截';
            const attribution = {
              finalProviderId: cached.finalProviderId,
              finalProviderName: cached.finalProviderName,
              finalRole: cached.finalRole,
              finalModel: cached.actualModel,
            };

            if (decision.action === 'error') {
              finish({
                outcome: 'rejected',
                httpStatus: 403,
                errorCode: 'moderation_output_blocked',
                errorMessage: blockedMessage,
                ...attribution,
              });
              res.status(403).json({ error: { message: blockedMessage, code: 'moderation_output_blocked' } });
              return;
            }

            const replacement = decision.action === 'response' ? cachedPolicy.outputResponse ?? '' : '';
            trace = withFirstResponse(trace);
            const synthetic = writeSyntheticSuccess(
              res,
              protocol,
              originalPayload,
              cached.actualModel ?? requestedModel ?? 'ai-proxy-policy',
              stream,
              replacement,
            );
            finish(
              {
                outcome: 'rejected',
                httpStatus: 200,
                errorCode: 'moderation_output_blocked',
                errorMessage: blockedMessage,
                ...attribution,
              },
              {
                clientRequest: originalPayload,
                upstreamRequest: { cacheHit: true, moderationBlocked: true },
                aiResponse: synthetic.responseBody,
              },
            );
            return;
          }
        }

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
    settings.fuzzyModelMatchingEnabled,
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

    const moderation = result?.moderation;
    if (moderation) {
      moderationEvents.push(
        toModerationEvent(moderation, outcome.provider.name, result?.actualModel ?? null),
      );
    }
    // 输出被拦截是策略决定而不是服务故障：记 rejected，交付率不把它算作上游失败
    const outputBlocked = moderation?.blocked === true;
    const attribution = {
      finalProviderId: outcome.provider.id,
      finalProviderName: outcome.provider.name,
      finalRole: outcome.role,
      finalModel: result?.actualModel ?? null,
    };

    finish(
      outputBlocked
        ? {
            outcome: 'rejected',
            httpStatus: result?.responseStatus ?? 200,
            errorCode: 'moderation_output_blocked',
            errorMessage: '模型输出被内容审核策略拦截',
            ...attribution,
            promptTokens: result?.promptTokens ?? 0,
            completionTokens: result?.completionTokens ?? 0,
          }
        : {
            outcome: 'upstream_ok',
            httpStatus: 200,
            ...attribution,
            promptTokens: result?.promptTokens ?? 0,
            completionTokens: result?.completionTokens ?? 0,
          },
      content,
    );

    // 被拦截的响应不写缓存，否则后续请求会被旧内容直接绕过新策略
    if (cacheKey && result && !outputBlocked) {
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
          sourceTraceId: trace.traceId,
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

const PROXY_POST_PATHS: ReadonlySet<string> = new Set<string>(PROXY_ROUTES.map((route) => route.path as string));

/**
 * 统一网关前置拦截：必须在 express.json 之前挂载。
 *
 * 所有 IP 级拦截 —— 黑名单（永久封禁）、临时拦截 / 限流（违禁内容策略产物）、
 * 以及多窗口请求上限 —— 都在这一个中间件里完成。命中时直接返回，
 * 请求体（上限 10MB）根本不会被读取，不消耗服务端带宽，也让攻击者
 * 无法用大 body 消耗资源。
 *
 * 被拒绝的请求仍然记入日志（此时没有 payload，仅记录 IP 与错误码）。
 * 配置读取失败时不拦截，交给正常链路返回 503，避免缓存故障放大成全站拒绝。
 * 内容类检查（违禁词 / IDE 检测）必须读取请求体，仍留在 handleProxyRequest。
 */
export const gatewayGuard: RequestHandler = (req, res, next) => {
  if (req.method !== 'POST' || !PROXY_POST_PATHS.has(req.path)) {
    next();
    return;
  }
  const ip = getClientIp(req);

  /*
   * 内存级临时拦截 / 限流不依赖配置快照，先同步判断，配置异常时依然生效。
   * 已有配置快照时用配置的拦截提示消息，否则退回默认文案。
   */
  const blockedMessage = peekConfig()?.settings.blockedErrorMessage ?? DEFAULT_BLOCKED_MESSAGE;
  const blockRemaining = temporaryBlockRemainingSec(ip);
  if (blockRemaining > 0) {
    gatewayReject(req, res, 403, 'ip_blocked', blockedMessage, blockRemaining);
    return;
  }
  const throttleRemaining = temporaryThrottleRemainingSec(ip);
  if (throttleRemaining > 0) {
    gatewayReject(req, res, 429, 'ip_throttled', blockedMessage, throttleRemaining);
    return;
  }

  void getConfig()
    .then((config) => {
      const message = config.settings.blockedErrorMessage;

      if (config.blacklistedIps.has(ip)) {
        gatewayReject(req, res, 403, 'ip_blacklisted', message);
        return;
      }

      // 多窗口限流：任一窗口超限即拒绝
      const rate = checkRateLimit(ip, rateLimitRules(config.settings));
      if (rate.limit > 0) {
        res.setHeader('X-RateLimit-Limit', String(rate.limit));
        res.setHeader('X-RateLimit-Remaining', String(rate.remaining ?? 0));
      }
      if (!rate.allowed) {
        const text = `请求过于频繁，同 IP ${rate.rule?.label ?? ''}最多 ${rate.limit} 次请求，请 ${rate.retryAfterSec} 秒后重试`;
        gatewayReject(req, res, 429, 'rate_limit_exceeded', text, rate.retryAfterSec);
        return;
      }

      next();
    })
    .catch(() => next());
};

/** 网关拒绝的默认报错消息：配置快照不可用时的兜底文案 */
const DEFAULT_BLOCKED_MESSAGE = '该 IP 已被禁止访问';

/** 网关层统一拒绝出口：写日志 + 返回错误体，可附加 Retry-After */
function gatewayReject(
  req: Request,
  res: Response,
  status: number,
  code: string,
  message: string,
  retryAfterSec?: number,
): void {
  if (retryAfterSec !== undefined) res.setHeader('Retry-After', String(retryAfterSec));
  enqueueRequestEvent(
    toRequestEvent(createTrace({ requestedModel: null, stream: false, ip: getClientIp(req) }), {
      outcome: 'rejected',
      httpStatus: status,
      errorCode: code,
      errorMessage: message,
    }),
  );
  res.status(status).json({ error: { message, code } });
}

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