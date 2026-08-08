/**
 * 超时解析 —— 纯函数。
 *
 * 优先级：provider 所属组的 timeout_ms > settings 默认超时。
 * 特殊 provider 各自有独立超时项。
 *
 * 取代旧实现的 `config.priorityTimeouts[String(Number(priority))]` 字符串键查找，
 * 改为组实体上的真实字段。
 */

import type { ProviderRecord, PriorityGroupRecord } from '../db/repo/providers';
import type { SettingsDTO } from '../types/api';

export function resolveTimeoutMs(
  provider: ProviderRecord,
  settings: SettingsDTO,
  groups: Map<number, PriorityGroupRecord>,
): number {
  if (provider.kind === 'fallback') return settings.fallbackResponseTimeoutMs;
  if (provider.kind === 'parallel') return settings.parallelTimeoutMs;

  const groupTimeout = groups.get(provider.priority)?.timeoutMs;
  return groupTimeout && groupTimeout > 0 ? groupTimeout : settings.defaultResponseTimeoutMs;
}

export class UpstreamTimeoutError extends Error {
  readonly status = 408;
  readonly code = 'MODEL_TIMEOUT';

  constructor(message: string) {
    super(message);
    this.name = 'UpstreamTimeoutError';
  }
}

function abortReason(signal: AbortSignal, fallback: Error): Error {
  return signal.reason instanceof Error ? signal.reason : fallback;
}

/** 以 AbortSignal 中断上游调用，区分服务超时与客户端主动断连。 */
export async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new UpstreamTimeoutError(message);
  const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);

  try {
    return await run(signal);
  } catch (error) {
    if (signal.aborted) throw abortReason(signal, timeoutError);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 流式场景的分片间隔超时。
 * 注意语义是「相邻 chunk 间隔」而非「总时长」，与旧实现一致：
 * 长回答不会因为总耗时超过阈值被误杀。
 */
export async function readChunkWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  message: string,
  externalSignal?: AbortSignal,
): Promise<IteratorResult<T>> {
  let timer: NodeJS.Timeout | null = null;
  let onAbort: (() => void) | null = null;
  const timeoutError = new UpstreamTimeoutError(message);

  if (externalSignal?.aborted) throw abortReason(externalSignal, new Error('Client disconnected'));

  try {
    const pending: Array<Promise<IteratorResult<T>>> = [
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError), timeoutMs);
      }),
    ];

    if (externalSignal) {
      pending.push(
        new Promise<never>((_, reject) => {
          onAbort = () => reject(abortReason(externalSignal, new Error('Client disconnected')));
          externalSignal.addEventListener('abort', onAbort, { once: true });
        }),
      );
    }

    return await Promise.race(pending);
  } finally {
    if (timer) clearTimeout(timer);
    if (externalSignal && onAbort) externalSignal.removeEventListener('abort', onAbort);
  }
}