/**
 * 明细保留策略。
 *
 * `requests` / `request_attempts` 会随流量线性增长，而日聚合表体积可控。
 * 因此只清理明细，聚合永久保留 —— 历史趋势不会因为清理而断档。
 *
 * `logRetentionDays = 0` 表示永不清理请求日志，但缓存始终按
 * `requestCacheReuseHours` 自动过期。
 * 请求明细依赖 request_attempts 的 on delete cascade，所以只删 requests 主行即可。
 */

import { pruneOldRequests } from '../db/repo/requests';
import { pruneExpiredCachedResponses } from '../db/repo/response-cache';
import { getConfig } from './config-cache';

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1_000;

let timer: NodeJS.Timeout | null = null;

export async function runRetentionSweep(): Promise<number> {
  const { settings } = await getConfig();

  try {
    const [requestDeleted, cacheDeleted] = await Promise.all([
      settings.logRetentionDays > 0 ? pruneOldRequests(settings.logRetentionDays) : Promise.resolve(0),
      pruneExpiredCachedResponses(settings.requestCacheReuseHours),
    ]);
    if (requestDeleted > 0) {
      console.log(`[Retention] pruned ${requestDeleted} requests older than ${settings.logRetentionDays}d`);
    }
    if (cacheDeleted > 0) {
      console.log(`[Cache] pruned ${cacheDeleted} responses older than ${settings.requestCacheReuseHours}h`);
    }
    return requestDeleted + cacheDeleted;
  } catch (error) {
    console.error(`[Retention] sweep failed: ${(error as Error).message}`);
    return 0;
  }
}

export function startRetentionSweeper(): void {
  if (timer) return;
  void runRetentionSweep();
  timer = setInterval(() => void runRetentionSweep(), SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopRetentionSweeper(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}