/**
 * 进程内计数器：IP 限流窗口、临时拦截/限流 与 round-robin 游标。
 *
 * 修掉旧实现的两处内存泄漏：
 *   - `requestBuckets` 只增不减，过期时间戳仅在该 IP 再次访问时才被清理
 *   - `rrCounters` / `modelRRCounters` 的 key 里嵌了 provider id 列表，
 *     配置一变就产生新 key，旧 key 永久驻留
 *
 * 这里给两者都加上界与淘汰。注意：状态是进程内的，多实例部署时
 * 限流按实例独立计算、average 规则的轮转也不跨实例同步 —— 这与旧实现一致，
 * 属于已知取舍，不是回归。
 *
 * 限流支持多个窗口同时生效（每分钟 / 每 10 分钟 / 每 30 分钟 / 自定义 x 小时），
 * 任一窗口超限即拒绝；放行时向每个启用窗口各自累加一次。
 * 临时拦截 / 限流是违禁内容策略的产物：命中后在网关层直接拒绝，
 * 不再读取请求体，见 src/http/proxy.ts 的 gatewayGuard。
 */

import type { RotationCursor } from '../core/routing';

/** 每分钟滑动窗口（兼容旧 ipRateLimitRpm） */
const WINDOW_MS = 60_000;
/** IP 桶上界，超出后按最久未活跃淘汰，防止 IP 空间膨胀打爆内存 */
const MAX_IP_BUCKETS = 50_000;
const MAX_CURSOR_KEYS = 10_000;

export interface RateLimitRule {
  /** 窗口长度，毫秒 */
  windowMs: number;
  /** 窗口内允许的最大请求数；<= 0 表示该窗口不启用 */
  limit: number;
  /** 错误消息里的窗口描述，例如「每 10 分钟」 */
  label: string;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** 命中的规则；放行时为第一个启用窗口的规则，不限流时为 null */
  rule: RateLimitRule | null;
  limit: number;
  remaining: number | null;
  retryAfterSec: number;
}

interface IpBucket {
  /** windowMs -> 该窗口内的时间戳列表 */
  windows: Map<number, number[]>;
  lastSeenMs: number;
}

const ipBuckets = new Map<string, IpBucket>();
const rotationCursors = new Map<string, number>();

/** 临时封禁 / 限流：ip -> 到期时间戳（ms）。命中后在网关层拒绝，不读取请求体。 */
const temporaryBlocks = new Map<string, number>();
const temporaryThrottles = new Map<string, number>();

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
 * 多窗口滑动窗口限流。每个启用窗口独立计数，任一窗口超限即拒绝，
 * 因此多个上限可以同时生效。阈值来自 settings（内存快照），本函数无 IO。
 */
export function checkRateLimit(ip: string | null, rules: RateLimitRule[]): RateLimitDecision {
  const enabled = rules.filter((rule) => Number.isFinite(rule.limit) && rule.limit > 0);
  if (enabled.length === 0) {
    return { allowed: true, rule: null, limit: 0, remaining: null, retryAfterSec: 0 };
  }

  const key = ip || 'unknown';
  const now = Date.now();
  const existing = ipBuckets.get(key);

  // 先把过期时间戳滑出窗口，再判断是否超限
  const windows = new Map<number, number[]>();
  if (existing) {
    for (const [windowMs, timestamps] of existing.windows) {
      windows.set(windowMs, timestamps.filter((ts) => now - ts < windowMs));
    }
  }

  for (const rule of enabled) {
    const recent = windows.get(rule.windowMs) ?? [];
    if (recent.length >= rule.limit) {
      // 窗口内最早一次请求滑出窗口的时刻，即可重试时刻
      const oldest = recent[0] ?? now;
      const retryAfterMs = rule.windowMs - (now - oldest);
      ipBuckets.set(key, { windows, lastSeenMs: now });
      return {
        allowed: false,
        rule,
        limit: rule.limit,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }
  }

  // 全部窗口都放行：向每个启用窗口追加当前时间戳
  for (const rule of enabled) {
    const recent = windows.get(rule.windowMs) ?? [];
    recent.push(now);
    windows.set(rule.windowMs, recent);
  }
  ipBuckets.set(key, { windows, lastSeenMs: now });

  const primary = enabled[0]!;
  return {
    allowed: true,
    rule: primary,
    limit: primary.limit,
    remaining: Math.max(primary.limit - (windows.get(primary.windowMs)?.length ?? 0), 0),
    retryAfterSec: 0,
  };
}

/** 周期清理完全空闲的 IP 桶与已过期的临时拦截/限流，避免只靠「再次访问」被动回收 */
export function sweepRateLimitBuckets(nowMs = Date.now()): number {
  let removed = 0;

  for (const [key, bucket] of ipBuckets) {
    if (nowMs - bucket.lastSeenMs > WINDOW_MS) {
      ipBuckets.delete(key);
      removed += 1;
    }
  }

  for (const [key, expiresAt] of temporaryBlocks) {
    if (expiresAt <= nowMs) {
      temporaryBlocks.delete(key);
      removed += 1;
    }
  }
  for (const [key, expiresAt] of temporaryThrottles) {
    if (expiresAt <= nowMs) {
      temporaryThrottles.delete(key);
      removed += 1;
    }
  }

  evictOldest(ipBuckets, MAX_IP_BUCKETS);
  return removed;
}

// ---------------------------------------------------------------- 临时拦截 / 限流

function temporaryRemainingSec(map: Map<string, number>, ip: string): number {
  const expiresAt = map.get(ip);
  if (expiresAt === undefined) return 0;
  const remaining = Math.ceil((expiresAt - Date.now()) / 1000);
  if (remaining <= 0) {
    map.delete(ip);
    return 0;
  }
  return remaining;
}

/** 临时封禁该 IP（网关 403），持续 minutes 分钟 */
export function blockIpTemporarily(ip: string, minutes: number): void {
  temporaryBlocks.set(ip, Date.now() + Math.max(1, minutes) * 60_000);
}

/** 临时限流该 IP（网关 429），持续 minutes 分钟 */
export function throttleIpTemporarily(ip: string, minutes: number): void {
  temporaryThrottles.set(ip, Date.now() + Math.max(1, minutes) * 60_000);
}

/** 剩余封禁秒数；0 表示未封禁或已过期 */
export function temporaryBlockRemainingSec(ip: string): number {
  return temporaryRemainingSec(temporaryBlocks, ip);
}

/** 剩余限流秒数；0 表示未限流或已过期 */
export function temporaryThrottleRemainingSec(ip: string): number {
  return temporaryRemainingSec(temporaryThrottles, ip);
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
  temporaryBlocks.clear();
  temporaryThrottles.clear();
}

export function counterStats(): {
  ipBuckets: number;
  rotationCursors: number;
  temporaryBlocks: number;
  temporaryThrottles: number;
} {
  return {
    ipBuckets: ipBuckets.size,
    rotationCursors: rotationCursors.size,
    temporaryBlocks: temporaryBlocks.size,
    temporaryThrottles: temporaryThrottles.size,
  };
}