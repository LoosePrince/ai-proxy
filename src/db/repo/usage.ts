/**
 * usage 仓储 —— 只读聚合查询。
 *
 * 写入口径见 requests.ts 的 buildIngestStatements：
 *   global_usage         单行全站汇总
 *   provider_usage_daily (provider_id, day) 原子累加
 *   model_usage_daily    (requested_model, actual_model, day) 原子累加
 *   ip_usage_daily       (ip_id, day) 原子累加
 *
 * 旧实现把这些塞在 JSON 里，只能拉全表到内存用 JS 遍历（aggregateAllStats）。
 * 现在聚合全部下推到 SQL，面板查询不再随数据量线性变慢。
 */

import { getDb } from '../lsqlite';
import type {
  DashboardSummaryDTO,
  IpUsageDTO,
  ModelUsageDTO,
  OutcomeBreakdown,
  ProviderKind,
  ProviderUsageDTO,
  PublicDailyStatsDTO,
  PublicDetailedStatsDTO,
  PublicModelStatsDTO,
  PublicStatsDTO,
  SuccessRates,
  UsageDailyDTO,
} from '../../types/api';

/** 可选的日期范围过滤，from/to 均为 YYYY-MM-DD */
export interface UsageRange {
  from?: string;
  to?: string;
}

function dayRange(range: UsageRange): { sql: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];

  if (range.from) {
    parts.push('day >= ?');
    params.push(range.from);
  }
  if (range.to) {
    parts.push('day <= ?');
    params.push(range.to);
  }

  return { sql: parts.length ? `where ${parts.join(' and ')}` : '', params };
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function percent(part: number, total: number): number {
  return total > 0 ? Number(((part / total) * 100).toFixed(1)) : 0;
}

/** 聚合行 -> 分类计数。所有维度共用一套列名，因此解析只有一份。 */
function toBreakdown(row: Record<string, unknown> | null | undefined): OutcomeBreakdown {
  const cacheHit = num(row?.cache_hits);
  const clientAbort = num(row?.client_aborts);
  const rejected = num(row?.rejected);
  // success 列含缓存命中，upstreamOk 要把它扣掉才是真实上游成功
  const upstreamOk = Math.max(num(row?.success) - cacheHit, 0);
  // failed 列含 rejected，扣掉后才是上游自身的失败
  const upstreamError = Math.max(num(row?.failed) - rejected, 0);

  return {
    requests: num(row?.requests),
    upstreamOk,
    cacheHit,
    upstreamError,
    clientAbort,
    rejected,
  };
}

/**
 * 由分类计数派生两个成功率。这是全站唯一的成功率定义处。
 *
 *   serviceSuccessRate  交付率：缓存复用算成功，客户端取消从分母剔除
 *   upstreamSuccessRate 上游健康度：只看真正打到上游的调用
 */
export function successRatesOf(breakdown: OutcomeBreakdown): SuccessRates {
  const delivered = breakdown.upstreamOk + breakdown.cacheHit;
  const attributable = Math.max(breakdown.requests - breakdown.clientAbort, 0);
  const upstreamCalls = breakdown.upstreamOk + breakdown.upstreamError;

  return {
    serviceSuccessRate: percent(delivered, attributable),
    upstreamSuccessRate: percent(breakdown.upstreamOk, upstreamCalls),
  };
}

function sumBreakdown(rows: OutcomeBreakdown[]): OutcomeBreakdown {
  return rows.reduce<OutcomeBreakdown>(
    (acc, row) => ({
      requests: acc.requests + row.requests,
      upstreamOk: acc.upstreamOk + row.upstreamOk,
      cacheHit: acc.cacheHit + row.cacheHit,
      upstreamError: acc.upstreamError + row.upstreamError,
      clientAbort: acc.clientAbort + row.clientAbort,
      rejected: acc.rejected + row.rejected,
    }),
    { requests: 0, upstreamOk: 0, cacheHit: 0, upstreamError: 0, clientAbort: 0, rejected: 0 },
  );
}

const AGGREGATE_COLUMNS = 'requests, success, failed, cache_hits, client_aborts, rejected';

/**
 * 公开统计。只读 global_usage 单行，替代旧实现的
 * `findMany({select:{stats,name}})` 全表扫描 + 内存聚合。
 *
 * 首页展示的 successRate 用交付率口径：缓存复用计入成功，客户端取消不计入分母。
 */
export async function getPublicStats(detailedStatsEnabled: boolean): Promise<PublicStatsDTO> {
  const row = await getDb().selectOne<Record<string, unknown>>(
    `select ${AGGREGATE_COLUMNS}, prompt_tokens, completion_tokens
       from global_usage where id = 1`,
  );

  const breakdown = toBreakdown(row);

  return {
    totalRequests: breakdown.requests,
    totalTokens: num(row?.prompt_tokens) + num(row?.completion_tokens),
    successRate: successRatesOf(breakdown).serviceSuccessRate,
    detailedStatsEnabled,
  };
}

interface ProviderUsageRow extends Record<string, unknown> {
  provider_id: number | null;
  provider_name: string;
  kind: string | null;
  enabled: number | null;
  requests: number;
  success: number;
  failed: number;
  cache_hits: number;
  client_aborts: number;
  rejected: number;
  prompt_tokens: number;
  completion_tokens: number;
}

/**
 * Provider 维度用量。
 * LEFT JOIN providers 是有意为之：provider 已删除时仍靠反规范化的 provider_name
 * 展示历史数据，保证「完整可追溯」。
 */
export async function getProviderUsage(range: UsageRange = {}): Promise<ProviderUsageDTO[]> {
  const { sql: whereSql, params } = dayRange(range);

  const rows = await getDb().select<ProviderUsageRow>(
    `select
        u.provider_id                     as provider_id,
        u.provider_name                   as provider_name,
        p.kind                            as kind,
        p.enabled                         as enabled,
        sum(u.requests)                   as requests,
        sum(u.success)                    as success,
        sum(u.failed)                     as failed,
        sum(u.cache_hits)                 as cache_hits,
        sum(u.client_aborts)              as client_aborts,
        sum(u.rejected)                   as rejected,
        sum(u.prompt_tokens)              as prompt_tokens,
        sum(u.completion_tokens)          as completion_tokens
      from provider_usage_daily u
      left join providers p on p.id = u.provider_id
      ${whereSql}
      group by u.provider_id, u.provider_name
      order by requests desc`,
    params,
  );

  return rows.map((row) => {
    const promptTokens = num(row.prompt_tokens);
    const completionTokens = num(row.completion_tokens);
    const breakdown = toBreakdown(row);

    return {
      providerId: row.provider_id ?? null,
      name: row.provider_name,
      kind: (row.kind as ProviderKind) ?? 'primary',
      // provider 行已被删除时视为未启用
      enabled: row.enabled === null ? false : Boolean(row.enabled),
      ...breakdown,
      ...successRatesOf(breakdown),
      success: num(row.success),
      failed: num(row.failed),
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  });
}

interface DailyUsageRow extends Record<string, unknown> {
  day: string;
  requests: number;
  success: number;
  failed: number;
  cache_hits: number;
  client_aborts: number;
  rejected: number;
  prompt_tokens: number;
  completion_tokens: number;
  historical_import: number;
}

/** 全站每日序列。按日升序返回，缺失日期由展示层补零。 */
export async function getDailyUsage(range: UsageRange = {}): Promise<UsageDailyDTO[]> {
  const { sql: whereSql, params } = dayRange(range);
  const rows = await getDb().select<DailyUsageRow>(
    `select day, ${AGGREGATE_COLUMNS}, prompt_tokens, completion_tokens,
            exists (
              select 1 from usage_daily_provenance p
               where p.day = global_usage_daily.day and p.kind = 'historical_import'
            ) as historical_import
       from global_usage_daily
       ${whereSql}
       order by day asc`,
    params,
  );

  return rows.map((row) => {
    const promptTokens = num(row.prompt_tokens);
    const completionTokens = num(row.completion_tokens);
    const breakdown = toBreakdown(row);

    return {
      day: row.day,
      isHistorical: Boolean(row.historical_import),
      ...breakdown,
      ...successRatesOf(breakdown),
      success: num(row.success),
      failed: num(row.failed),
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  });
}

export async function getDashboardSummary(range: UsageRange = {}): Promise<DashboardSummaryDTO> {
  const [daily, providers] = await Promise.all([getDailyUsage(range), getProviderUsage(range)]);
  const breakdown = sumBreakdown(daily);
  const tokens = daily.reduce(
    (acc, item) => ({
      promptTokens: acc.promptTokens + item.promptTokens,
      completionTokens: acc.completionTokens + item.completionTokens,
    }),
    { promptTokens: 0, completionTokens: 0 },
  );

  return {
    ...breakdown,
    ...successRatesOf(breakdown),
    totalRequests: breakdown.requests,
    successRequests: breakdown.upstreamOk + breakdown.cacheHit,
    failedRequests: breakdown.upstreamError + breakdown.rejected,
    promptTokens: tokens.promptTokens,
    completionTokens: tokens.completionTokens,
    totalTokens: tokens.promptTokens + tokens.completionTokens,
    providers,
  };
}

interface ModelUsageRow {
  requested_model: string;
  actual_model: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
}

/**
 * 模型维度用量，按请求模型分组并展开真实模型分布。
 * 取代旧的 stats.models[x].actualResolved 嵌套 JSON。
 */
export async function getModelUsage(range: UsageRange = {}): Promise<ModelUsageDTO[]> {
  const { sql: whereSql, params } = dayRange(range);

  const rows = await getDb().select<ModelUsageRow>(
    `select
        requested_model,
        actual_model,
        sum(requests)           as requests,
        sum(prompt_tokens)      as prompt_tokens,
        sum(completion_tokens)  as completion_tokens
      from model_usage_daily
      ${whereSql}
      group by requested_model, actual_model
      order by requests desc`,
    params,
  );

  const grouped = new Map<string, ModelUsageDTO>();

  for (const row of rows) {
    let entry = grouped.get(row.requested_model);
    if (!entry) {
      entry = {
        requestedModel: row.requested_model,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        actualResolved: [],
      };
      grouped.set(row.requested_model, entry);
    }

    const requests = num(row.requests);
    entry.requests += requests;
    entry.promptTokens += num(row.prompt_tokens);
    entry.completionTokens += num(row.completion_tokens);
    entry.actualResolved.push({ model: row.actual_model, requests });
  }

  return [...grouped.values()].sort((a, b) => b.requests - a.requests);
}

interface ActualModelUsageRow {
  actual_model: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
}

/**
 * 按真实模型聚合。
 *
 * `getModelUsage` 的职责是后台的「请求模型 -> 真实模型」映射，
 * 它先按 requested_model 分组。公开状态页不需要请求别名，而是需要展示
 * 实际被路由到的模型列表，因此在这里直接按 actual_model 汇总。
 */
async function getActualModelUsage(range: UsageRange): Promise<PublicModelStatsDTO[]> {
  const { sql: whereSql, params } = dayRange(range);
  const rows = await getDb().select<ActualModelUsageRow>(
    `select
        actual_model,
        sum(requests) as requests,
        sum(prompt_tokens) as prompt_tokens,
        sum(completion_tokens) as completion_tokens
       from model_usage_daily
       ${whereSql}
       group by actual_model
       order by requests desc, actual_model asc`,
    params,
  );

  return rows.map((row) => ({
    model: row.actual_model,
    requests: num(row.requests),
    totalTokens: num(row.prompt_tokens) + num(row.completion_tokens),
  }));
}

interface IpUsageRow {
  ip: string | null;
  requests: number;
  tokens: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

export async function getIpUsage(range: UsageRange = {}, limit = 200): Promise<IpUsageDTO[]> {
  const { sql: whereSql, params } = dayRange(range);

  const rows = await getDb().select<IpUsageRow>(
    `select
        i.ip                as ip,
        sum(u.requests)     as requests,
        sum(u.tokens)       as tokens,
        min(u.day)          as first_seen_at,
        max(u.day)          as last_seen_at
      from ip_usage_daily u
      join ips i on i.id = u.ip_id
      ${whereSql}
      group by u.ip_id, i.ip
      order by requests desc
      limit ?`,
    [...params, limit],
  );

  return rows.map((row) => ({
    ip: row.ip ?? 'unknown',
    requests: num(row.requests),
    tokens: num(row.tokens),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  }));
}

// ---------------------------------------------------------------- 公开详细统计

/** 详细状态页的天数窗口。固定上限，避免公开接口被用来拉全量历史。 */
const PUBLIC_DETAIL_DAYS = 30;
/** 公开页最多列出的模型数，长尾合并成「其他」 */
const PUBLIC_MODEL_LIMIT = 12;

function toPublicDaily(row: UsageDailyDTO): PublicDailyStatsDTO {
  return {
    day: row.day,
    isHistorical: row.isHistorical,
    requests: row.requests,
    success: row.upstreamOk + row.cacheHit,
    failed: row.upstreamError + row.rejected,
    cacheHit: row.cacheHit,
    clientAbort: row.clientAbort,
    totalTokens: row.totalTokens,
    serviceSuccessRate: row.serviceSuccessRate,
    upstreamSuccessRate: row.upstreamSuccessRate,
  };
}

function dayOffset(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 公开详细统计。
 *
 * 刻意只暴露聚合口径：Provider 名称、IP 与请求正文都不出站，
 * 因此这里不复用 getProviderUsage 的结果，只取一个「参与路由的 Provider 数量」
 * 让访客能判断服务规模，而不泄露谁在提供服务。
 */
export async function getPublicDetailedStats(): Promise<PublicDetailedStatsDTO> {
  const from = dayOffset(PUBLIC_DETAIL_DAYS - 1);
  const db = getDb();

  const [daily, models, providerRow] = await Promise.all([
    getDailyUsage({ from }),
    getActualModelUsage({ from }),
    db.selectOne<{ total: number }>(
      `select count(*) as total from providers where enabled = 1`,
    ),
  ]);

  const breakdown = sumBreakdown(daily);
  const promptTokens = daily.reduce((sum, row) => sum + row.promptTokens, 0);
  const completionTokens = daily.reduce((sum, row) => sum + row.completionTokens, 0);

  // 已按真实模型聚合并排序；这里只负责控制公开页列表长度。
  const visible = models.slice(0, PUBLIC_MODEL_LIMIT);
  const tail = models.slice(PUBLIC_MODEL_LIMIT);
  if (tail.length > 0) {
    visible.push({
      model: `其他 ${tail.length} 个模型`,
      requests: tail.reduce((sum, row) => sum + row.requests, 0),
      totalTokens: tail.reduce((sum, row) => sum + row.totalTokens, 0),
    });
  }

  return {
    overall: { ...breakdown, ...successRatesOf(breakdown) },
    totalTokens: promptTokens + completionTokens,
    promptTokens,
    completionTokens,
    activeProviders: num(providerRow?.total),
    daily: daily.map(toPublicDaily),
    models: visible,
    generatedAt: new Date().toISOString(),
  };
}