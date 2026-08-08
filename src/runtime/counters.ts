/**
 * 进程内计数器：IP 限流窗口 与 round-robin 游标。
 *
 * 修掉旧实现的两处内存泄漏：
 *   - `requestBuckets` 只增不减，过期时间戳仅在该 IP 再次访问时才被清理
 *   - `rrCounters` / `modelRRCounters` 的 key 里嵌了 provider id 列表，
 *     配置一变就产生新 key，旧 key 永久驻留
 *
 * 这里给两者都加上界与淘汰。注意：状态是进程内的，多实例部署时
 * 限流按实例独立计算、average 规则的轮转也不跨实例同步 —— 这与旧实现一致，
 * 属于已知取舍，不是回归。
 */

import type { RotationCursor } from '../core/routing';

const WINDOW_MS = 60_000;
/** IP 桶上界，超出后按最久未活跃淘汰，防止 IP 空间膨胀打爆内存 */
const MAX_IP_BUCKETS = 50_000;
const MAX_CURSOR_KEYS = 10_000;

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number | null;
  retryAfterSec: number;
}

interface IpBucket {
  timestamps: number[];
  lastSeenMs: number;
}

const ipBuckets = new Map<string, IpBucket>();
const rotationCursors = new Map<string, number>();

/** Map 迭代顺序即插入顺序，删除最先插入的若干项即近似 LRU */
function evictOldest<K, V>(map: Map<K, V>, targetSize: number): void {
  if (map.size <= targetSize) return;
  const excess = map.size - targetSize;
  let removed = 0;
  for (const key of map.keys()) {
    map.delete(key);
    removed += 1;
    if (removed >= excess) break;
  }
}

/**
 * 滑动窗口限流。`limitRpm <= 0` 表示不限流。
 * 阈值来自 settings（内存快照），因此本函数无 IO。
 */
export function checkRateLimit(ip: string | null, limitRpm: number): RateLimitDecision {
  if (!Number.isFinite(limitRpm) || limitRpm <= 0) {
    return { allowed: true, limit: 0, remaining: null, retryAfterSec: 0 };
  }

  const limit = Math.round(limitRpm);
  const key = ip || 'unknown';
  const now = Date.now();
  const bucket = ipBuckets.get(key);
  const recent = bucket ? bucket.timestamps.filter((ts) => now - ts < WINDOW_MS) : [];

  if (recent.length >= limit) {
    // 窗口内最早一次请求滑出窗口的时刻，即可重试时刻
    const oldest = recent[0] ?? now;
    const retryAfterMs = WINDOW_MS - (now - oldest);
    ipBuckets.set(key, { timestamps: recent, lastSeenMs: now });
    return {
      allowed: false,
      limit,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    };
  }

  recent.push(now);
  ipBuckets.set(key, { timestamps: recent, lastSeenMs: now });

  return { allowed: true, limit, remaining: limit - recent.length, retryAfterSec: 0 };
}

/** 周期清理完全空闲的 IP 桶，避免只靠「再次访问」被动回收 */
export function sweepRateLimitBuckets(nowMs = Date.now()): number {
  let removed = 0;

  for (const [key, bucket] of ipBuckets) {
    if (nowMs - bucket.lastSeenMs > WINDOW_MS) {
      ipBuckets.delete(key);
      removed += 1;
    }
  }

  evictOldest(ipBuckets, MAX_IP_BUCKETS);
  return removed;
}

/** round-robin 游标，供 core/routing 的 average 规则使用 */
export const rotationCursor: RotationCursor = {
  next(key: string): number {
    const current = rotationCursors.get(key) ?? 0;
    rotationCursors.set(key, current + 1);
    if (rotationCursors.size > MAX_CURSOR_KEYS) evictOldest(rotationCursors, MAX_CURSOR_KEYS);
    return current;
  },
};

/** 供测试隔离状态 */
export function resetCounters(): void {
  ipBuckets.clear();
  rotationCursors.clear();
}

export function counterStats(): { ipBuckets: number; rotationCursors: number } {
  return { ipBuckets: ipBuckets.size, rotationCursors: rotationCursors.size };
}