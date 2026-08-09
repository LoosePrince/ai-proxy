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
  ProviderKind,
  ProviderUsageDTO,
  PublicStatsDTO,
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

function rate(success: number, total: number): number {
  return total > 0 ? Number(((success / total) * 100).toFixed(1)) : 0;
}

/**
 * 公开统计。只读 global_usage 单行，替代旧实现的
 * `findMany({select:{stats,name}})` 全表扫描 + 内存聚合。
 */
export async function getPublicStats(): Promise<PublicStatsDTO> {
  const row = await getDb().selectOne<Record<string, unknown>>(
    `select requests, success, prompt_tokens, completion_tokens
       from global_usage where id = 1`,
  );

  const requests = num(row?.requests);
  const tokens = num(row?.prompt_tokens) + num(row?.completion_tokens);

  return {
    totalRequests: requests,
    totalTokens: tokens,
    successRate: rate(num(row?.success), requests),
  };
}

interface ProviderUsageRow {
  provider_id: number | null;
  provider_name: string;
  kind: string | null;
  enabled: number | null;
  requests: number;
  success: number;
  failed: number;
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

    return {
      providerId: row.provider_id ?? null,
      name: row.provider_name,
      kind: (row.kind as ProviderKind) ?? 'primary',
      // provider 行已被删除时视为未启用
      enabled: row.enabled === null ? false : Boolean(row.enabled),
      requests: num(row.requests),
      success: num(row.success),
      failed: num(row.failed),
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  });
}

interface DailyUsageRow {
  day: string;
  requests: number;
  success: number;
  failed: number;
  prompt_tokens: number;
  completion_tokens: number;
}

/** 全站每日序列。按日升序返回，缺失日期由展示层补零。 */
export async function getDailyUsage(range: UsageRange = {}): Promise<UsageDailyDTO[]> {
  const { sql: whereSql, params } = dayRange(range);
  const rows = await getDb().select<DailyUsageRow>(
    `select day, requests, success, failed, prompt_tokens, completion_tokens
       from global_usage_daily
       ${whereSql}
       order by day asc`,
    params,
  );

  return rows.map((row) => {
    const requests = num(row.requests);
    const success = num(row.success);
    const promptTokens = num(row.prompt_tokens);
    const completionTokens = num(row.completion_tokens);
    return {
      day: row.day,
      requests,
      success,
      failed: num(row.failed),
      successRate: rate(success, requests),
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  });
}

export async function getDashboardSummary(range: UsageRange = {}): Promise<DashboardSummaryDTO> {
  const [daily, providers] = await Promise.all([getDailyUsage(range), getProviderUsage(range)]);
  const totals = daily.reduce(
    (acc, item) => ({
      requests: acc.requests + item.requests,
      success: acc.success + item.success,
      failed: acc.failed + item.failed,
      promptTokens: acc.promptTokens + item.promptTokens,
      completionTokens: acc.completionTokens + item.completionTokens,
    }),
    { requests: 0, success: 0, failed: 0, promptTokens: 0, completionTokens: 0 },
  );

  return {
    totalRequests: totals.requests,
    successRequests: totals.success,
    failedRequests: totals.failed,
    successRate: rate(totals.success, totals.requests),
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    totalTokens: totals.promptTokens + totals.completionTokens,
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