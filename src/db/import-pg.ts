/**
 * 一次性导入：PostgreSQL 单表 `Provider` -> Lsqlite 规范化多表。
 *
 * 旧库把配置、路由规则、全站统计、IP 统计、模型统计全部塞在同一张表里：
 * 真实 provider 是 priority >= 0 的行，其余是 priority 为负的「虚拟行」，
 * 各自用 stats JSON 承载完全不同的语义。本脚本按语义拆解到目标表：
 *
 *   真实行 (priority >= 0)
 *     -> providers + provider_models + priority_groups + provider_usage_daily
 *   stats.modelConfig            -> settings + priority_groups.timeout_ms
 *   modelConfig.fallbackProvider -> providers(kind='fallback')
 *   modelConfig.parallelProvider -> providers(kind='parallel')
 *   stats.specialProviders       -> provider_usage_daily（保底/并行的历史用量）
 *   顶层 rule（路由控制行）        -> settings.globalRule
 *   stats.totalRequests 等        -> global_usage
 *   stats.ips                    -> ips + ip_usage_daily
 *   stats.models                 -> model_usage_daily
 *
 * 两个无法消除的信息缺口，不做伪造：
 *   1. 旧实现的请求日志只存在内存、上限 200 条、重启即丢，数据库里没有任何
 *      单请求明细。因此 `requests` / `request_attempts` 无法回填，保持为空，
 *      迁移后新产生的请求才有完整链路。
 *   2. 旧聚合值没有日期维度，只有累计数。因此全部落到单个「历史日桶」，
 *      日期取源数据中最大的 updatedAt（UTC 日）。此前的逐日分布不可恢复。
 *
 * 幂等：所有写入都是按主键 upsert 且**覆盖**而非累加，可安全重跑。
 */

import 'dotenv/config';
import pg from 'pg';
import { getDb } from './lsqlite';
import type { LsqliteStatement } from './lsqlite';
import { contributionProviderName, normalizeContributor } from '../core/contribution';
import type { ContributorType, RoutingRule } from '../types/api';

/** 保底 / 并行 provider 在旧库中没有独立行，导入时分配固定 id 保证重跑稳定 */
const FALLBACK_PROVIDER_ID = 90001;
const PARALLEL_PROVIDER_ID = 90002;

/** Lsqlite 服务端对 /api/transaction 的 statements 数组限制为 100 条 */
const BATCH_SIZE = 100;

interface LegacyRow {
  id: number;
  name: string;
  /** 后期迁移才加的列，早期贡献行仍为 null，需回退到 name */
  contributor: string | null;
  baseUrl: string;
  apiKey: string;
  models: unknown;
  rule: string | null;
  priority: number;
  enabled: boolean;
  isEnv: boolean;
  isContributed: boolean;
  stats: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

interface SpecialProviderSpec {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: unknown;
  enabled?: boolean;
}

interface LegacyUsage {
  totalRequests?: number;
  successRequests?: number;
  failedRequests?: number;
  totalPromptTokens?: number;
  totalCompletionTokens?: number;
}

/** Supabase 走自签证书链，且新版 pg 把 sslmode=require 当 verify-full 处理 */
function buildPgClient(url: string): pg.Client {
  const stripped = url.replace(/[?&]sslmode=[^&]*/g, '').replace(/[?&]$/, '');
  return new pg.Client({ connectionString: stripped, ssl: { rejectUnauthorized: false } });
}

async function connectSource(): Promise<pg.Client> {
  const candidates = [
    { label: 'DATABASE_URL', url: process.env.DATABASE_URL },
    { label: 'DIRECT_URL', url: process.env.DIRECT_URL },
  ].filter((item): item is { label: string; url: string } => Boolean(item.url));

  if (candidates.length === 0) throw new Error('DATABASE_URL / DIRECT_URL 均未配置');

  const failures: string[] = [];
  for (const { label, url } of candidates) {
    const client = buildPgClient(url);
    try {
      await client.connect();
      console.log(`[Import] source connected via ${label}`);
      return client;
    } catch (error) {
      failures.push(`${label}: ${(error as Error).message}`);
      await client.end().catch(() => undefined);
    }
  }

  throw new Error(`无法连接源库\n  ${failures.join('\n  ')}`);
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function toPositive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function toModelList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.map((item) => String(item ?? '').trim()).filter(Boolean))];
}

function normalizeRule(value: unknown): RoutingRule {
  if (value === 'random') return 'random';
  if (value === 'average' || value === 'balanced') return 'average';
  return 'priority';
}

function isoOf(value: Date | string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

/**
 * 贡献者标识：旧库把邮箱写进 name 列，contributor 列在部分行仍为 null。
 * 优先取 contributor，回退到 name，无法解析时降级为 managed。
 */
function resolveContributor(row: LegacyRow): { contributor: string; contributorType: ContributorType } | null {
  const raw = row.contributor || row.name;
  try {
    const normalized = normalizeContributor(raw);
    return { contributor: normalized.contributor, contributorType: normalized.contributorType };
  } catch {
    return null;
  }
}

function upsertProviderStatement(values: {
  id: number;
  name: string;
  baseUrl: string;
  apiKey: string;
  priority: number;
  kind: 'primary' | 'fallback' | 'parallel';
  enabled: boolean;
  source: 'managed' | 'env' | 'contributed';
  contributor: string | null;
  contributorType: string | null;
  createdAt: string;
  updatedAt: string;
}): LsqliteStatement {
  return {
    sql: `insert into providers (
            id, name, base_url, api_key, priority, kind, enabled, is_env, source,
            contributor, contributor_type, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict (id) do update set
            name = excluded.name,
            base_url = excluded.base_url,
            api_key = excluded.api_key,
            priority = excluded.priority,
            kind = excluded.kind,
            enabled = excluded.enabled,
            is_env = excluded.is_env,
            source = excluded.source,
            contributor = excluded.contributor,
            contributor_type = excluded.contributor_type,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at`,
    params: [
      values.id,
      values.name,
      values.baseUrl,
      values.apiKey,
      values.priority,
      values.kind,
      values.enabled ? 1 : 0,
      values.source === 'env' ? 1 : 0,
      values.source,
      values.contributor,
      values.contributorType,
      values.createdAt,
      values.updatedAt,
    ],
    mode: 'write',
  };
}

function modelStatements(providerId: number, models: string[]): LsqliteStatement[] {
  const statements: LsqliteStatement[] = [
    { sql: 'delete from provider_models where provider_id = ?', params: [providerId], mode: 'write' },
  ];
  models.forEach((model, index) => {
    statements.push({
      sql: 'insert into provider_models (provider_id, model, sort_order) values (?, ?, ?)',
      params: [providerId, model, index],
      mode: 'write',
    });
  });
  return statements;
}

function settingStatement(key: string, value: string | number, now: string): LsqliteStatement {
  return {
    sql: `insert into settings (key, value, updated_at) values (?, ?, ?)
          on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    params: [key, String(value), now],
    mode: 'write',
  };
}

function groupStatement(
  priority: number,
  rule: RoutingRule,
  timeoutMs: number | null,
  now: string,
): LsqliteStatement {
  return {
    sql: `insert into priority_groups (priority, rule, timeout_ms, updated_at) values (?, ?, ?, ?)
          on conflict (priority) do update set
            rule = excluded.rule,
            timeout_ms = excluded.timeout_ms,
            updated_at = excluded.updated_at`,
    params: [priority, rule, timeoutMs, now],
    mode: 'write',
  };
}

/** 覆盖而非累加，保证重跑不翻倍 */
function providerUsageStatement(
  providerId: number,
  providerName: string,
  day: string,
  usage: LegacyUsage,
): LsqliteStatement {
  return {
    sql: `insert into provider_usage_daily (
            provider_id, provider_name, day, requests, success, failed,
            prompt_tokens, completion_tokens
          ) values (?, ?, ?, ?, ?, ?, ?, ?)
          on conflict (provider_id, day) do update set
            provider_name = excluded.provider_name,
            requests = excluded.requests,
            success = excluded.success,
            failed = excluded.failed,
            prompt_tokens = excluded.prompt_tokens,
            completion_tokens = excluded.completion_tokens`,
    params: [
      providerId,
      providerName,
      day,
      toNumber(usage.totalRequests),
      toNumber(usage.successRequests),
      toNumber(usage.failedRequests),
      toNumber(usage.totalPromptTokens),
      toNumber(usage.totalCompletionTokens),
    ],
    mode: 'write',
  };
}

/**
 * 模型统计展开。
 *
 * 旧结构：models[requested] = { requested, promptTokens, completionTokens, actualResolved: { actual: n } }
 * 目标结构按 (requested, actual, day) 分行存请求数与 token。
 *
 * actualResolved 只记录了「解析到不同真实模型」的次数，未被记录的部分意味着
 * 真实模型与请求模型一致，因此补一条 actual = requested 的余量行。
 * token 没有按真实模型拆分，全部记在请求数最多的那一行 —— 保证按请求模型
 * 汇总的 token 总量准确，同时不给其他行编造数字。
 */
function modelUsageStatements(models: Record<string, unknown>, day: string): LsqliteStatement[] {
  const statements: LsqliteStatement[] = [];

  for (const [requestedModel, rawEntry] of Object.entries(models)) {
    const entry = (rawEntry ?? {}) as Record<string, unknown>;
    const totalRequests = toNumber(entry.requested);
    const promptTokens = toNumber(entry.promptTokens);
    const completionTokens = toNumber(entry.completionTokens);
    const resolved = (entry.actualResolved ?? {}) as Record<string, unknown>;

    const rows = new Map<string, number>();
    let resolvedTotal = 0;
    for (const [actualModel, count] of Object.entries(resolved)) {
      const n = toNumber(count);
      if (n <= 0) continue;
      rows.set(actualModel, (rows.get(actualModel) ?? 0) + n);
      resolvedTotal += n;
    }

    const remainder = totalRequests - resolvedTotal;
    if (remainder > 0 || rows.size === 0) {
      rows.set(requestedModel, (rows.get(requestedModel) ?? 0) + Math.max(remainder, 0));
    }

    // token 归到请求数最大的行，避免按比例拆分产生虚假精度
    let tokenBearer = requestedModel;
    let maxRequests = -1;
    for (const [actualModel, count] of rows) {
      if (count > maxRequests) {
        maxRequests = count;
        tokenBearer = actualModel;
      }
    }

    for (const [actualModel, count] of rows) {
      const isBearer = actualModel === tokenBearer;
      statements.push({
        sql: `insert into model_usage_daily (
                requested_model, actual_model, day, requests, prompt_tokens, completion_tokens
              ) values (?, ?, ?, ?, ?, ?)
              on conflict (requested_model, actual_model, day) do update set
                requests = excluded.requests,
                prompt_tokens = excluded.prompt_tokens,
                completion_tokens = excluded.completion_tokens`,
        params: [
          requestedModel,
          actualModel,
          day,
          count,
          isBearer ? promptTokens : 0,
          isBearer ? completionTokens : 0,
        ],
        mode: 'write',
      });
    }
  }

  return statements;
}

function ipStatements(ips: Record<string, unknown>, day: string, now: string): LsqliteStatement[] {
  const statements: LsqliteStatement[] = [];

  for (const [ip, rawEntry] of Object.entries(ips)) {
    const entry = (rawEntry ?? {}) as Record<string, unknown>;
    statements.push({
      sql: `insert into ips (ip, first_seen_at, last_seen_at) values (?, ?, ?)
            on conflict (ip) do update set last_seen_at = excluded.last_seen_at`,
      params: [ip, now, now],
      mode: 'write',
    });
    statements.push({
      sql: `insert into ip_usage_daily (ip_id, day, requests, tokens)
            values ((select id from ips where ip = ?), ?, ?, ?)
            on conflict (ip_id, day) do update set
              requests = excluded.requests,
              tokens = excluded.tokens`,
      params: [ip, day, toNumber(entry.requests), toNumber(entry.tokens)],
      mode: 'write',
    });
  }

  return statements;
}

/**
 * models 维度表。
 *
 * 旧库没有独立的模型维度，模型名散落在 providers.models JSON 与 stats.models 的
 * key / actualResolved key 里。这里把所有出现过的模型名收敛成维度行，
 * 与运行时 buildIngestStatements 的写入口径保持一致。
 */
function modelDimensionStatements(names: Iterable<string>, now: string): LsqliteStatement[] {
  const unique = [...new Set([...names].map((name) => String(name ?? '').trim()).filter(Boolean))];

  return unique.map((name) => ({
    sql: `insert into models (name, first_seen_at, last_seen_at) values (?, ?, ?)
          on conflict (name) do update set last_seen_at = excluded.last_seen_at`,
    params: [name, now, now],
    mode: 'write' as const,
  }));
}

interface Plan {
  statements: LsqliteStatement[];
  summary: string[];
}

function buildPlan(rows: LegacyRow[]): Plan {
  const statements: LsqliteStatement[] = [];
  const summary: string[] = [];

  const now = new Date().toISOString();
  // 历史聚合没有日期维度，统一落到源数据最后活跃的那一天
  const legacyDay = rows
    .map((row) => isoOf(row.updatedAt, now).slice(0, 10))
    .sort()
    .pop() ?? now.slice(0, 10);

  const realRows = rows.filter((row) => row.priority >= 0);
  const virtualRows = rows.filter((row) => row.priority < 0);

  // ---------------- 真实 provider ----------------
  const groupRules = new Map<number, RoutingRule>();

  for (const row of realRows) {
    const models = toModelList(row.models);
    const createdAt = isoOf(row.createdAt, now);
    const updatedAt = isoOf(row.updatedAt, now);
    const contributorInfo = row.isContributed ? resolveContributor(row) : null;

    const source = contributorInfo ? 'contributed' : row.isEnv ? 'env' : 'managed';
    // 贡献记录改用 apiKey 派生的稳定内部名，与新贡献流程一致
    const name = contributorInfo ? contributionProviderName(row.apiKey) : row.name;

    statements.push(
      upsertProviderStatement({
        id: row.id,
        name,
        baseUrl: row.baseUrl,
        apiKey: row.apiKey,
        priority: row.priority,
        kind: 'primary',
        enabled: row.enabled,
        source,
        contributor: contributorInfo?.contributor ?? null,
        contributorType: contributorInfo?.contributorType ?? null,
        createdAt,
        updatedAt,
      }),
      ...modelStatements(row.id, models),
    );

    // 旧实现组内规则取「组内第一个 provider 的 rule」，这里沿用首个出现的值
    if (!groupRules.has(row.priority)) groupRules.set(row.priority, normalizeRule(row.rule));

    const usage = (row.stats ?? {}) as LegacyUsage;
    if (toNumber(usage.totalRequests) > 0) {
      statements.push(providerUsageStatement(row.id, name, legacyDay, usage));
    }

    summary.push(
      `provider #${row.id} ${name} [${source}] priority=${row.priority} models=${models.length} requests=${toNumber(usage.totalRequests)}`,
    );
  }

  // ---------------- 虚拟行拆解 ----------------
  let globalRule: RoutingRule | null = null;
  let modelConfig: Record<string, unknown> | null = null;
  let specialProviders: Record<string, unknown> | null = null;
  let globalUsage: LegacyUsage | null = null;
  let ipStats: Record<string, unknown> | null = null;
  let modelStats: Record<string, unknown> | null = null;

  for (const row of virtualRows) {
    const stats = (row.stats ?? {}) as Record<string, unknown>;

    // 按 stats 形状识别语义，而不是依赖 __xxx__ 名字，避免命名变体漏读
    if (stats.modelConfig) {
      modelConfig = stats.modelConfig as Record<string, unknown>;
      globalRule = normalizeRule(row.rule);
      if (stats.specialProviders) specialProviders = stats.specialProviders as Record<string, unknown>;
    }
    if (stats.ips) ipStats = stats.ips as Record<string, unknown>;
    if (stats.models) modelStats = stats.models as Record<string, unknown>;
    if (stats.totalRequests !== undefined && !stats.modelConfig) {
      globalUsage = stats as LegacyUsage;
    }
  }

  // ---------------- settings ----------------
  if (globalRule) statements.push(settingStatement('globalRule', globalRule, now));

  if (modelConfig) {
    const defaultTimeout = toPositive(modelConfig.defaultResponseTimeoutMs);
    const fallbackTimeout = toPositive(modelConfig.fallbackResponseTimeoutMs);
    const parallelTimeout = toPositive(modelConfig.parallelTimeoutMs);
    const ipRateLimit = modelConfig.ipRateLimitRpm;

    if (defaultTimeout !== null) statements.push(settingStatement('defaultResponseTimeoutMs', defaultTimeout, now));
    if (fallbackTimeout !== null) statements.push(settingStatement('fallbackResponseTimeoutMs', fallbackTimeout, now));
    if (parallelTimeout !== null) statements.push(settingStatement('parallelTimeoutMs', parallelTimeout, now));
    if (ipRateLimit !== undefined && ipRateLimit !== null) {
      statements.push(settingStatement('ipRateLimitRpm', Math.max(toNumber(ipRateLimit), 0), now));
    }

    summary.push(
      `settings globalRule=${globalRule} defaultTimeout=${defaultTimeout ?? '-'} fallbackTimeout=${fallbackTimeout ?? '-'} parallelTimeout=${parallelTimeout ?? '-'}`,
    );

    // priorityTimeouts 从 JSON blob 迁到 priority_groups.timeout_ms
    const priorityTimeouts = (modelConfig.priorityTimeouts ?? {}) as Record<string, unknown>;
    for (const [priority, timeout] of Object.entries(priorityTimeouts)) {
      const p = Number(priority);
      const ms = toPositive(timeout);
      if (!Number.isInteger(p) || ms === null) continue;
      statements.push(groupStatement(p, groupRules.get(p) ?? 'priority', ms, now));
      groupRules.delete(p);
      summary.push(`priority_group ${p} timeout=${ms}ms`);
    }
  }

  for (const [priority, rule] of groupRules) {
    statements.push(groupStatement(priority, rule, null, now));
    summary.push(`priority_group ${priority} rule=${rule}`);
  }

  // ---------------- 保底 / 并行 provider ----------------
  const specialSpecs: Array<{
    id: number;
    kind: 'fallback' | 'parallel';
    spec: SpecialProviderSpec | null;
    statsKey: string;
  }> = [
    {
      id: FALLBACK_PROVIDER_ID,
      kind: 'fallback',
      spec: (modelConfig?.fallbackProvider ?? null) as SpecialProviderSpec | null,
      statsKey: '__special_fallback__',
    },
    {
      id: PARALLEL_PROVIDER_ID,
      kind: 'parallel',
      spec: (modelConfig?.parallelProvider ?? null) as SpecialProviderSpec | null,
      statsKey: '__special_parallel__',
    },
  ];

  for (const { id, kind, spec, statsKey } of specialSpecs) {
    if (!spec?.baseUrl || !spec?.apiKey) continue;

    const name = String(spec.name || kind).trim() || kind;
    const models = toModelList(spec.models);

    statements.push(
      upsertProviderStatement({
        id,
        name,
        baseUrl: spec.baseUrl,
        apiKey: spec.apiKey,
        priority: 0,
        kind,
        enabled: Boolean(spec.enabled),
        source: 'managed',
        contributor: null,
        contributorType: null,
        createdAt: now,
        updatedAt: now,
      }),
      ...modelStatements(id, models),
    );

    const usage = (specialProviders?.[statsKey] ?? null) as LegacyUsage | null;
    if (usage && toNumber(usage.totalRequests) > 0) {
      statements.push(providerUsageStatement(id, name, legacyDay, usage));
    }

    summary.push(
      `${kind} provider #${id} ${name} enabled=${Boolean(spec.enabled)} models=${models.length} requests=${toNumber(usage?.totalRequests)}`,
    );
  }

  // ---------------- 全站汇总 ----------------
  if (globalUsage) {
    statements.push({
      sql: `update global_usage set
              requests = ?, success = ?, failed = ?,
              prompt_tokens = ?, completion_tokens = ?
            where id = 1`,
      params: [
        toNumber(globalUsage.totalRequests),
        toNumber(globalUsage.successRequests),
        toNumber(globalUsage.failedRequests),
        toNumber(globalUsage.totalPromptTokens),
        toNumber(globalUsage.totalCompletionTokens),
      ],
      mode: 'write',
    });
    summary.push(
      `global_usage requests=${toNumber(globalUsage.totalRequests)} success=${toNumber(globalUsage.successRequests)} tokens=${toNumber(globalUsage.totalPromptTokens) + toNumber(globalUsage.totalCompletionTokens)}`,
    );
  }

  // ---------------- IP / 模型统计 ----------------
  if (ipStats) {
    const ipCount = Object.keys(ipStats).length;
    statements.push(...ipStatements(ipStats, legacyDay, now));
    summary.push(`ip_usage_daily ${ipCount} ips -> day ${legacyDay}`);
  }

  if (modelStats) {
    const before = statements.length;
    statements.push(...modelUsageStatements(modelStats, legacyDay));
    summary.push(
      `model_usage_daily ${Object.keys(modelStats).length} requested models -> ${statements.length - before} rows`,
    );
  }

  // ---------------- models 维度 ----------------
  const modelNames = new Set<string>();
  for (const row of realRows) {
    for (const model of toModelList(row.models)) modelNames.add(model);
  }
  for (const { spec } of specialSpecs) {
    for (const model of toModelList(spec?.models)) modelNames.add(model);
  }
  for (const [requestedModel, rawEntry] of Object.entries(modelStats ?? {})) {
    modelNames.add(requestedModel);
    const resolved = ((rawEntry ?? {}) as Record<string, unknown>).actualResolved ?? {};
    for (const actualModel of Object.keys(resolved as Record<string, unknown>)) {
      modelNames.add(actualModel);
    }
  }

  if (modelNames.size > 0) {
    statements.push(...modelDimensionStatements(modelNames, now));
    summary.push(`models ${modelNames.size} distinct model names`);
  }

  return { statements, summary };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  const source = await connectSource();
  let rows: LegacyRow[];
  try {
    const result = await source.query<LegacyRow>(
      `select id, name, contributor, "baseUrl", "apiKey", models, rule, priority, enabled,
              "isEnv", "isContributed", stats, "createdAt", "updatedAt"
         from "Provider" order by priority asc, id asc`,
    );
    rows = result.rows;
  } finally {
    await source.end().catch(() => undefined);
  }

  console.log(`[Import] read ${rows.length} legacy rows`);

  const { statements, summary } = buildPlan(rows);
  console.log('\n[Import] plan:');
  for (const line of summary) console.log(`  - ${line}`);
  console.log(`\n[Import] ${statements.length} statements`);
  console.log('[Import] requests / request_attempts 保持为空：旧库不存在单请求明细');

  if (dryRun) {
    console.log('[Import] dry-run，未写入任何数据');
    return;
  }

  const db = getDb();
  for (let offset = 0; offset < statements.length; offset += BATCH_SIZE) {
    const batch = statements.slice(offset, offset + BATCH_SIZE);
    await db.transaction(batch);
    console.log(`[Import] committed ${Math.min(offset + batch.length, statements.length)}/${statements.length}`);
  }

  console.log('[Import] done');
}

main().catch((error) => {
  console.error('[Import] FAILED:', (error as Error).message);
  process.exit(1);
});