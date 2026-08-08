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

/** 以 AbortSignal 中断上游调用，超时抛 UpstreamTimeoutError */
export async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted || (error as Error)?.name === 'AbortError') {
      throw new UpstreamTimeoutError(message);
    }
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
): Promise<IteratorResult<T>> {
  let timer: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new UpstreamTimeoutError(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}