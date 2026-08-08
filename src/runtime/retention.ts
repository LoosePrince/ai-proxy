/**
 * 明细保留策略。
 *
 * `requests` / `request_attempts` 会随流量线性增长，而日聚合表体积可控。
 * 因此只清理明细，聚合永久保留 —— 历史趋势不会因为清理而断档。
 *
 * `logRetentionDays = 0` 表示永不清理（默认值）。
 * 依赖 request_attempts 的 on delete cascade（已在实例上验证 foreign_keys=1），
 * 所以只删 requests 主行即可。
 */

import { pruneOldRequests } from '../db/repo/requests';
import { getConfig } from './config-cache';

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1_000;

let timer: NodeJS.Timeout | null = null;

export async function runRetentionSweep(): Promise<number> {
  const { settings } = await getConfig();
  if (settings.logRetentionDays <= 0) return 0;

  try {
    const deleted = await pruneOldRequests(settings.logRetentionDays);
    if (deleted > 0) {
      console.log(`[Retention] pruned ${deleted} requests older than ${settings.logRetentionDays}d`);
    }
    return deleted;
  } catch (error) {
    console.error(`[Retention] sweep failed: ${(error as Error).message}`);
    return 0;
  }
}

export function startRetentionSweeper(): void {
  if (timer) return;
  timer = setInterval(() => void runRetentionSweep(), SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopRetentionSweeper(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}