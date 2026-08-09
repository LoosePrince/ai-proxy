/**
 * 请求追踪累积。
 *
 * 修掉旧实现的一个真实 bug：日志条目里存的是 `routeTrace` 对象引用，
 * 而同一请求后续的 attempt 仍会 push 进同一个 `attempts` 数组，
 * 导致已经写入日志缓冲区的历史条目被**追溯性改写**。
 * （旧代码里定义了 `cloneRouteTrace` 想解决这个问题，但从未被调用。）
 *
 * 这里的做法是：Trace 只做不可变累积，每次 `withAttempt` 返回新对象，
 * 最终由 `toRequestEvent` 一次性物化成待落盘事件。纯函数，无 IO。
 */

import type { AttemptRole, AttemptStatus } from '../types/api';
import type { AttemptEventInput, RequestEventInput } from '../db/repo/requests';

export interface TraceAttemptInput {
  role: AttemptRole;
  providerId: number | null;
  providerName: string;
  priority: number | null;
  attemptedModel: string | null;
  actualModel?: string | null;
  timeoutMs: number | null;
  status: AttemptStatus;
  errorMessage?: string | null;
  startedAtMs: number;
  endedAtMs?: number;
}

export interface Trace {
  readonly traceId: string;
  readonly startedAtMs: number;
  readonly firstResponseAtMs: number | null;
  readonly requestedModel: string | null;
  readonly stream: boolean;
  readonly ip: string | null;
  readonly attempts: readonly AttemptEventInput[];
  readonly fallbackTriggered: boolean;
}

export interface TraceOutcome {
  success: boolean;
  httpStatus: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  finalProviderId?: number | null;
  finalProviderName?: string | null;
  finalRole?: AttemptRole | null;
  finalModel?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  cacheHit?: boolean;
}

let traceCounter = 0;

/** 进程内单调递增 + 时间前缀，足以在 trace_id 上保证唯一且可按时间排序 */
function nextTraceId(startedAtMs: number): string {
  traceCounter = (traceCounter + 1) % 1_000_000;
  return `${startedAtMs.toString(36)}-${traceCounter.toString(36)}-${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function createTrace(input: {
  requestedModel: string | null;
  stream: boolean;
  ip: string | null;
  nowMs?: number;
}): Trace {
  const startedAtMs = input.nowMs ?? Date.now();
  return {
    traceId: nextTraceId(startedAtMs),
    startedAtMs,
    firstResponseAtMs: null,
    requestedModel: input.requestedModel,
    stream: input.stream,
    ip: input.ip,
    attempts: [],
    fallbackTriggered: false,
  };
}

/** 首字节时刻只记录一次，用于 TTFB */
export function withFirstResponse(trace: Trace, nowMs = Date.now()): Trace {
  if (trace.firstResponseAtMs !== null) return trace;
  return { ...trace, firstResponseAtMs: nowMs };
}

export function withFallbackTriggered(trace: Trace): Trace {
  if (trace.fallbackTriggered) return trace;
  return { ...trace, fallbackTriggered: true };
}

/**
 * 追加一次尝试记录。返回新 Trace，原对象不变。
 * 包含失败与 claimed-by-other —— 旧实现里这些中途失败只打 console.warn 就丢掉了。
 */
export function withAttempt(trace: Trace, input: TraceAttemptInput): Trace {
  const endedAtMs = input.endedAtMs ?? Date.now();

  const attempt: AttemptEventInput = {
    seq: trace.attempts.length + 1,
    role: input.role,
    providerId: input.providerId,
    providerName: input.providerName,
    priority: input.priority,
    attemptedModel: input.attemptedModel,
    actualModel: input.status === 'success' ? input.actualModel ?? input.attemptedModel : null,
    timeoutMs: input.timeoutMs,
    status: input.status,
    errorMessage: input.errorMessage ?? null,
    startedAt: new Date(input.startedAtMs).toISOString(),
    durationMs: endedAtMs - input.startedAtMs,
  };

  return { ...trace, attempts: [...trace.attempts, attempt] };
}

/** 物化为待落盘事件。此时 attempts 已定型，不会再被后续写入影响。 */
export function toRequestEvent(
  trace: Trace,
  outcome: TraceOutcome,
  nowMs = Date.now(),
): RequestEventInput {
  return {
    traceId: trace.traceId,
    startedAt: new Date(trace.startedAtMs).toISOString(),
    firstResponseAt: trace.firstResponseAtMs ? new Date(trace.firstResponseAtMs).toISOString() : null,
    completedAt: new Date(nowMs).toISOString(),
    ttfbMs: trace.firstResponseAtMs ? trace.firstResponseAtMs - trace.startedAtMs : null,
    totalMs: nowMs - trace.startedAtMs,
    ip: trace.ip,
    requestedModel: trace.requestedModel,
    finalModel: outcome.finalModel ?? null,
    finalProviderId: outcome.finalProviderId ?? null,
    finalProviderName: outcome.finalProviderName ?? null,
    finalRole: outcome.finalRole ?? null,
    stream: trace.stream,
    cacheHit: outcome.cacheHit ?? false,
    success: outcome.success,
    httpStatus: outcome.httpStatus,
    errorCode: outcome.errorCode ?? null,
    errorMessage: outcome.errorMessage ?? null,
    promptTokens: outcome.promptTokens ?? 0,
    completionTokens: outcome.completionTokens ?? 0,
    fallbackTriggered: trace.fallbackTriggered,
    attempts: [...trace.attempts],
  };
}