/**
 * 端点健康仓储 —— 后台「状态监控」页的只读聚合查询。
 *
 * 数据来源是 endpoint_health_daily（写入见 requests.ts 的 buildIngestStatements，
 * 表结构与口径见 migrations/015_endpoint_health.ts）。这里刻意不扫描
 * requests / request_attempts：
 *   - 明细会被 logRetentionDays 清理，30 天窗口随时可能断档；
 *   - Lsqlite 是远程 HTTPS SQLite，扫描明细会让页面随流量变慢。
 *
 * 每个维度只发两条查询（逐日样本 + 维度元数据），按日折叠、算百分比、判状态
 * 都在 JS 里做 —— 返回行数是「维度 × 天数」量级，而不是请求量级。
 *
 * 窗口固定 30 天：状态页同时要展示 7 / 15 / 30 天可用率，因此没有「选窗口」
 * 这个概念，三个数字都从同一份逐日样本里切出来，口径不会互相漂移。
 *
 * 展示口径：
 *   - 可用率只统计真正打到上游的尝试，claimed-by-other（并行竞速落败）不进分母；
 *   - 延迟只取成功尝试，失败/超时的耗时没有可比性；
 *   - 「端点 PING」是窗口内成功请求首字节的最小值，是真实流量的连通性近似，
 *     不是主动探测出来的空载 RTT（页面文案会写明这一点）。
 */

import { getDb } from '../lsqlite';
import type {
  ChannelHealthDTO,
  EndpointHealthDTO,
  EndpointHealthSampleDTO,
  EndpointHealthState,
  ModelHealthDTO,
  ProviderKind,
} from '../../types/api';

/** 状态阈值（可用率百分比）。唯一的判定源，前端只按它上色。 */
export const HEALTH_OK_THRESHOLD = 95;
export const HEALTH_DEGRADED_THRESHOLD = 80;

/** 统计窗口。状态判定固定用最近 7 天，避免短窗口把小样本噪声放大成故障。 */
export const HEALTH_WINDOW_DAYS = 30;
export const HEALTH_STATE_WINDOW_DAYS = 7;

/** 与 requests.ts 的 UNKNOWN_MODEL 一致：尝试没有模型名时的占位符 */
const UNKNOWN_MODEL = '(unspecified)';
const UNKNOWN_MODEL_DISPLAY = '（未指定）';

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percent(part: number, total: number): number | null {
  if (total <= 0) return null;
  return Number(((part / total) * 100).toFixed(1));
}

/**
 * 由窗口内的成败次数判定状态。
 *
 * 分母为 0 时返回 idle 而不是 down：没有请求不代表渠道坏了，
 * 把它标成故障会让「所有渠道」列表在低频部署上全是红色。
 */
export function classifyHealth(success: number, failed: number): EndpointHealthState {
  const total = success + failed;
  if (total <= 0) return 'idle';

  const availability = (success / total) * 100;
  if (availability >= HEALTH_OK_THRESHOLD) return 'ok';
  if (availability >= HEALTH_DEGRADED_THRESHOLD) return 'degraded';
  return 'down';
}

/** 状态严重度，用于「先看坏的」排序：异常 > 降级 > 正常 > 无流量 */
const STATE_RANK: Record<EndpointHealthState, number> = { down: 0, degraded: 1, ok: 2, idle: 3 };

/** 窗口内的日期列表（升序），与 samples 一一对应 */
function windowDaysList(windowDays: number): string[] {
  const today = Date.now();
  return Array.from({ length: windowDays }, (_, index) =>
    new Date(today - (windowDays - 1 - index) * 86_400_000).toISOString().slice(0, 10),
  );
}

interface HealthDayRow {
  label: string;
  /** 仅渠道查询会返回 */
  provider_id?: number | null;
  day: string;
  attempts: number;
  success: number;
  failed: number;
  claimed: number;
  duration_sum_ms: number;
  duration_count: number;
  ttfb_min_ms: number | null;
  last_seen_at: string | null;
}

interface DayBucket {
  attempts: number;
  success: number;
  failed: number;
  claimed: number;
  durationSum: number;
  durationCount: number;
  ttfbMin: number | null;
  lastSeenAt: string | null;
}

/** 把同一维度的逐日行折叠成 day -> 计数，渠道与模型共用，避免两套口径漂移 */
type HealthAggregate = Map<string, DayBucket>;

function foldRow(aggregate: HealthAggregate, row: HealthDayRow): void {
  const day = row.day;
  const bucket = aggregate.get(day) ?? {
    attempts: 0,
    success: 0,
    failed: 0,
    claimed: 0,
    durationSum: 0,
    durationCount: 0,
    ttfbMin: null,
    lastSeenAt: null,
  };

  bucket.attempts += num(row.attempts);
  bucket.success += num(row.success);
  bucket.failed += num(row.failed);
  bucket.claimed += num(row.claimed);
  bucket.durationSum += num(row.duration_sum_ms);
  bucket.durationCount += num(row.duration_count);

  const ttfb = nullableNum(row.ttfb_min_ms);
  if (ttfb !== null && (bucket.ttfbMin === null || ttfb < bucket.ttfbMin)) bucket.ttfbMin = ttfb;
  if (row.last_seen_at && (!bucket.lastSeenAt || row.last_seen_at > bucket.lastSeenAt)) {
    bucket.lastSeenAt = row.last_seen_at;
  }

  aggregate.set(day, bucket);
}

function emptySample(day: string): EndpointHealthSampleDTO {
  return { day, attempts: 0, success: 0, failed: 0, state: 'idle', availability: null };
}

interface WindowStats {
  samples: EndpointHealthSampleDTO[];
  attempts: number;
  success: number;
  failed: number;
  claimed: number;
  success7d: number;
  failed7d: number;
  /** 最近有流量的那天的平均耗时 */
  latestLatencyMs: number | null;
  avgLatency7d: number | null;
  pingMs: number | null;
  lastSeenAt: string | null;
}

function windowStats(aggregate: HealthAggregate, days: string[]): WindowStats {
  const samples: EndpointHealthSampleDTO[] = [];
  const lastDay = days.at(-1) ?? '';
  const sevenDayStart = days.at(-HEALTH_STATE_WINDOW_DAYS) ?? lastDay;

  let attempts = 0;
  let success = 0;
  let failed = 0;
  let claimed = 0;
  let success7d = 0;
  let failed7d = 0;
  let durationSum7d = 0;
  let durationCount7d = 0;
  let pingMs: number | null = null;
  let latestLatencyMs: number | null = null;
  let lastSeenAt: string | null = null;

  for (const day of days) {
    const bucket = aggregate.get(day);
    if (!bucket) {
      // 没有样本的日子补 idle 占位：前端不必猜缺哪几天，色条长度恒等于窗口长度
      samples.push(emptySample(day));
      continue;
    }

    attempts += bucket.attempts;
    success += bucket.success;
    failed += bucket.failed;
    claimed += bucket.claimed;
    if (bucket.ttfbMin !== null && (pingMs === null || bucket.ttfbMin < pingMs)) pingMs = bucket.ttfbMin;
    if (bucket.lastSeenAt && (!lastSeenAt || bucket.lastSeenAt > lastSeenAt)) lastSeenAt = bucket.lastSeenAt;
    // 升序遍历，最后赋值的就是最近有流量的那天
    if (bucket.durationCount > 0) latestLatencyMs = Math.round(bucket.durationSum / bucket.durationCount);

    if (day >= sevenDayStart) {
      success7d += bucket.success;
      failed7d += bucket.failed;
      durationSum7d += bucket.durationSum;
      durationCount7d += bucket.durationCount;
    }

    samples.push({
      day,
      attempts: bucket.attempts,
      success: bucket.success,
      failed: bucket.failed,
      state: classifyHealth(bucket.success, bucket.failed),
      availability: percent(bucket.success, bucket.success + bucket.failed),
    });
  }

  return {
    samples,
    attempts,
    success,
    failed,
    claimed,
    success7d,
    failed7d,
    latestLatencyMs,
    avgLatency7d: durationCount7d > 0 ? Math.round(durationSum7d / durationCount7d) : null,
    pingMs,
    lastSeenAt,
  };
}

/** 从逐日样本里切一个窗口的可用率 */
function availabilityOf(samples: EndpointHealthSampleDTO[], windowDays: number): number | null {
  const slice = samples.slice(-windowDays);
  const success = slice.reduce((sum, sample) => sum + sample.success, 0);
  const failed = slice.reduce((sum, sample) => sum + sample.failed, 0);
  return percent(success, success + failed);
}

interface ProviderMetaRow {
  id: number;
  name: string;
  kind: string;
  enabled: number;
}

/**
 * 渠道健康。
 *
 * 「所有渠道」= 有流量的渠道 ∪ providers 表里的每一行（含停用的），
 * 因此没有任何流量的渠道也会以「无流量」出现，而不是从列表里消失。
 */
async function getChannelHealth(days: string[]): Promise<ChannelHealthDTO[]> {
  const db = getDb();
  const [dayRows, providerRows] = await Promise.all([
    db.select<HealthDayRow>(
      `select
          provider_id                        as provider_id,
          provider_name                      as label,
          day                                as day,
          sum(attempts)                      as attempts,
          sum(success)                       as success,
          sum(failed)                        as failed,
          sum(claimed)                       as claimed,
          sum(duration_sum_ms)               as duration_sum_ms,
          sum(duration_count)                as duration_count,
          min(ttfb_min_ms)                   as ttfb_min_ms,
          max(last_seen_at)                  as last_seen_at
        from endpoint_health_daily
        where day >= ?
        group by provider_id, provider_name, day
        order by day asc`,
      [days[0] ?? ''],
    ),
    db.select<ProviderMetaRow>('select id, name, kind, enabled from providers'),
  ]);

  const meta = new Map(providerRows.map((row) => [Number(row.id), row]));
  const aggregates = new Map<number, { name: string; aggregate: HealthAggregate }>();

  for (const row of dayRows) {
    const providerId = Number(row.provider_id ?? 0);
    let entry = aggregates.get(providerId);
    if (!entry) {
      entry = { name: row.label || '', aggregate: new Map() };
      aggregates.set(providerId, entry);
    }
    // provider 改名后历史行仍是旧名，以 providers 表为准
    const currentName = meta.get(providerId)?.name;
    if (currentName) entry.name = currentName;
    foldRow(entry.aggregate, row);
  }

  const channels: ChannelHealthDTO[] = [];

  for (const [providerId, entry] of aggregates) {
    const stats = windowStats(entry.aggregate, days);
    const provider = meta.get(providerId);
    channels.push({
      providerId,
      name: entry.name || `渠道 #${providerId}`,
      kind: (provider?.kind as ProviderKind | undefined) ?? null,
      // provider 行已被删除时视为停用
      enabled: provider === undefined ? false : Boolean(Number(provider.enabled)),
      state: classifyHealth(stats.success7d, stats.failed7d),
      latestLatencyMs: stats.latestLatencyMs,
      pingMs: stats.pingMs,
      availability7d: availabilityOf(stats.samples, 7),
      availability30d: availabilityOf(stats.samples, HEALTH_WINDOW_DAYS),
      avgLatency7d: stats.avgLatency7d,
      attempts7d: stats.success7d + stats.failed7d,
      success7d: stats.success7d,
      failed7d: stats.failed7d,
      claimed7d: stats.claimed,
      attempts30d: stats.attempts,
      lastSeenAt: stats.lastSeenAt,
      samples: stats.samples,
    });
  }

  // 零流量的渠道也补进来，保持「所有渠道」的语义
  for (const row of providerRows) {
    const providerId = Number(row.id);
    if (aggregates.has(providerId)) continue;
    channels.push({
      providerId,
      name: row.name,
      kind: (row.kind as ProviderKind) ?? null,
      enabled: Boolean(Number(row.enabled)),
      state: 'idle',
      latestLatencyMs: null,
      pingMs: null,
      availability7d: null,
      availability30d: null,
      avgLatency7d: null,
      attempts7d: 0,
      success7d: 0,
      failed7d: 0,
      claimed7d: 0,
      attempts30d: 0,
      lastSeenAt: null,
      samples: days.map(emptySample),
    });
  }

  return channels.sort(
    (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.attempts30d - a.attempts30d || a.name.localeCompare(b.name),
  );
}

interface ModelTrafficRow {
  actual_model: string;
  requests: number;
}

/**
 * 模型健康。
 *
 * 「所有模型」= 有上游尝试的模型 ∪ 窗口内有请求的模型（可能全部命中缓存，
 * 因此没有任何上游尝试）。后者以「无流量」出现，避免只用缓存时模型凭空消失。
 */
async function getModelHealth(days: string[]): Promise<ModelHealthDTO[]> {
  const db = getDb();
  const from = days[0] ?? '';
  const [dayRows, trafficRows] = await Promise.all([
    db.select<HealthDayRow>(
      `select
          model                              as label,
          day                                as day,
          sum(attempts)                      as attempts,
          sum(success)                       as success,
          sum(failed)                        as failed,
          sum(claimed)                       as claimed,
          sum(duration_sum_ms)               as duration_sum_ms,
          sum(duration_count)                as duration_count,
          min(ttfb_min_ms)                   as ttfb_min_ms,
          max(last_seen_at)                  as last_seen_at
        from endpoint_health_daily
        where day >= ?
        group by model, day
        order by day asc`,
      [from],
    ),
    db.select<ModelTrafficRow>(
      `select actual_model as actual_model, sum(requests) as requests
         from model_usage_daily
        where day >= ?
        group by actual_model`,
      [from],
    ),
  ]);

  const aggregates = new Map<string, HealthAggregate>();
  for (const row of dayRows) {
    let aggregate = aggregates.get(row.label);
    if (!aggregate) {
      aggregate = new Map();
      aggregates.set(row.label, aggregate);
    }
    foldRow(aggregate, row);
  }

  // 只有缓存命中的模型也出现在列表里（attempts 全 0）
  for (const row of trafficRows) {
    if (!aggregates.has(row.actual_model)) aggregates.set(row.actual_model, new Map());
  }

  const models: ModelHealthDTO[] = [];
  for (const [name, aggregate] of aggregates) {
    const stats = windowStats(aggregate, days);
    models.push({
      model: name === UNKNOWN_MODEL ? UNKNOWN_MODEL_DISPLAY : name,
      state: classifyHealth(stats.success7d, stats.failed7d),
      latestLatencyMs: stats.latestLatencyMs,
      availability7d: availabilityOf(stats.samples, 7),
      availability15d: availabilityOf(stats.samples, 15),
      availability30d: availabilityOf(stats.samples, HEALTH_WINDOW_DAYS),
      avgLatency7d: stats.avgLatency7d,
      attempts7d: stats.success7d + stats.failed7d,
      attempts30d: stats.attempts,
      lastSeenAt: stats.lastSeenAt,
      samples: stats.samples,
    });
  }

  return models.sort(
    (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.attempts30d - a.attempts30d || a.model.localeCompare(b.model),
  );
}

/** 状态监控页的完整数据。窗口固定 30 天，7 / 15 / 30 天可用率从同一份样本切出。 */
export async function getEndpointHealth(): Promise<EndpointHealthDTO> {
  const days = windowDaysList(HEALTH_WINDOW_DAYS);
  const [channels, models] = await Promise.all([getChannelHealth(days), getModelHealth(days)]);

  return {
    windowDays: HEALTH_WINDOW_DAYS,
    channels,
    models,
    generatedAt: new Date().toISOString(),
  };
}
