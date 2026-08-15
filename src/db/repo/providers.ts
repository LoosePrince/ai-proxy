/**
 * providers 仓储。
 *
 * 相对旧实现的关键变化：
 *   - models 从 JSON 数组变为 provider_models 关联行
 *   - fallback / parallel 从 `id: -10001` 伪对象变为 kind 字段标记的真实行
 *   - 组内路由规则从「取组内第一个 provider 的 rule」变为 priority_groups 的组级属性
 *
 * 读取一律走 `loadRoutingSnapshot`：一次查询取回全部路由所需数据，
 * 由 runtime/config-cache 缓存，热路径零往返。
 */

import { getDb } from '../lsqlite';
import type { LsqliteStatement } from '../lsqlite';
import { insert, remove, select, update, upsert, whereEq } from '../sql';
import { normalizeRoutingRule } from './settings';
import type {
  ProviderKind,
  ProviderSource,
  RoutingRule,
} from '../../types/api';

/** 路由决策所需的 provider 形态。apiKey 只在服务端内部流转，不进任何 DTO。 */
export interface ProviderRecord {
  id: number;
  name: string;
  baseUrl: string;
  apiKey: string;
  systemPrompt: string;
  models: string[];
  kind: ProviderKind;
  source: ProviderSource;
  priority: number;
  enabled: boolean;
  contributor: string | null;
  contributorType: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PriorityGroupRecord {
  priority: number;
  rule: RoutingRule;
  timeoutMs: number | null;
}

export interface RoutingSnapshot {
  providers: ProviderRecord[];
  groups: Map<number, PriorityGroupRecord>;
}

interface ProviderRow {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  system_prompt: string;
  kind: string;
  source: string;
  priority: number;
  enabled: number;
  contributor: string | null;
  contributor_type: string | null;
  created_at: string;
  updated_at: string;
  /** group_concat 聚合结果，按 sort_order 排序 */
  models: string | null;
}

const PROVIDER_COLUMNS = `
  p.id, p.name, p.base_url, p.api_key, p.system_prompt, p.kind, p.source, p.priority, p.enabled,
  p.contributor, p.contributor_type, p.created_at, p.updated_at,
  (select group_concat(m.model, char(10))
     from (select model from provider_models
            where provider_id = p.id
            order by sort_order, id) m) as models`;

function normalizeKind(value: unknown): ProviderKind {
  return value === 'fallback' || value === 'parallel' ? value : 'primary';
}

function normalizeSource(value: unknown): ProviderSource {
  return value === 'env' || value === 'contributed' ? value : 'managed';
}

function toProviderRecord(row: ProviderRow): ProviderRecord {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    systemPrompt: row.system_prompt ?? '',
    models: row.models ? row.models.split('\n').filter(Boolean) : [],
    kind: normalizeKind(row.kind),
    source: normalizeSource(row.source),
    priority: Number(row.priority) || 0,
    enabled: !!row.enabled,
    contributor: row.contributor,
    contributorType: row.contributor_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 一次取回路由所需的全部状态，供配置缓存使用 */
export async function loadRoutingSnapshot(): Promise<RoutingSnapshot> {
  const db = getDb();
  const [providerRows, groupRows] = await Promise.all([
    db.select<ProviderRow>(
      `select ${PROVIDER_COLUMNS} from providers p order by p.priority asc, p.id asc`,
    ),
    db.select<{ priority: number; rule: string; timeout_ms: number | null }>(
      'select priority, rule, timeout_ms from priority_groups',
    ),
  ]);

  const groups = new Map<number, PriorityGroupRecord>();
  for (const row of groupRows) {
    groups.set(Number(row.priority), {
      priority: Number(row.priority),
      rule: normalizeRoutingRule(row.rule),
      timeoutMs: row.timeout_ms === null ? null : Number(row.timeout_ms),
    });
  }

  return { providers: providerRows.map(toProviderRecord), groups };
}

export async function findProviderById(id: number): Promise<ProviderRecord | null> {
  const row = await getDb().selectOne<ProviderRow>(
    `select ${PROVIDER_COLUMNS} from providers p where p.id = ?`,
    [id],
  );
  return row ? toProviderRecord(row) : null;
}

export async function findProviderByName(name: string): Promise<ProviderRecord | null> {
  const row = await getDb().selectOne<ProviderRow>(
    `select ${PROVIDER_COLUMNS} from providers p where p.name = ?`,
    [name],
  );
  return row ? toProviderRecord(row) : null;
}

/** 同一 apiKey 的贡献记录，用于贡献提交时判断创建还是更新 */
export async function findContributedByApiKey(apiKey: string): Promise<ProviderRecord | null> {
  const row = await getDb().selectOne<ProviderRow>(
    `select ${PROVIDER_COLUMNS} from providers p where p.source = 'contributed' and p.api_key = ?`,
    [apiKey],
  );
  return row ? toProviderRecord(row) : null;
}

function modelStatements(providerId: number, models: string[]): LsqliteStatement[] {
  const unique = [...new Set(models.map((m) => String(m || '').trim()).filter(Boolean))];
  // 全量替换而非增量比对：模型列表很短，替换比 diff 更简单且无中间态
  const statements: LsqliteStatement[] = [
    remove('provider_models', whereEq({ provider_id: providerId })),
  ];

  unique.forEach((model, index) => {
    statements.push(
      insert('provider_models', { provider_id: providerId, model, sort_order: index }),
    );
  });

  return statements;
}

export interface CreateProviderInput {
  name: string;
  baseUrl: string;
  apiKey: string;
  systemPrompt?: string;
  models: string[];
  kind?: ProviderKind;
  source?: ProviderSource;
  priority?: number;
  enabled?: boolean;
  contributor?: string | null;
  contributorType?: string | null;
}

export async function createProvider(input: CreateProviderInput): Promise<ProviderRecord> {
  const db = getDb();
  const now = new Date().toISOString();
  const row = insert('providers', {
    name: input.name,
    base_url: input.baseUrl,
    api_key: input.apiKey,
    system_prompt: input.systemPrompt ?? '',
    kind: input.kind ?? 'primary',
    source: input.source ?? 'managed',
    priority: input.priority ?? 0,
    enabled: input.enabled ?? true,
    is_env: (input.source ?? 'managed') === 'env',
    contributor: input.contributor ?? null,
    contributor_type: input.contributorType ?? null,
    created_at: now,
    updated_at: now,
  });

  // returning 已验证可用，省掉一次「插入后再查 id」的往返
  const created = await db.query<{ id: number }>({
    sql: `${row.sql} returning id`,
    params: row.params,
    mode: 'write',
  });

  const id = Number(created.rows[0]?.id);
  if (!Number.isFinite(id)) throw new Error('createProvider: failed to obtain inserted id');

  await db.transaction([
    ...modelStatements(id, input.models),
    ...ensureGroupStatements(input.priority ?? 0, now),
  ]);

  const record = await findProviderById(id);
  if (!record) throw new Error('createProvider: inserted row not found');
  return record;
}

export interface UpdateProviderInput {
  name?: string;
  baseUrl?: string;
  /** 省略表示保留原值 */
  apiKey?: string;
  systemPrompt?: string;
  models?: string[];
  kind?: ProviderKind;
  priority?: number;
  enabled?: boolean;
  contributor?: string | null;
  contributorType?: string | null;
}

export async function updateProvider(id: number, input: UpdateProviderInput): Promise<ProviderRecord | null> {
  const now = new Date().toISOString();
  const fields: Record<string, unknown> = { updated_at: now };

  if (input.name !== undefined) fields.name = input.name;
  if (input.baseUrl !== undefined) fields.base_url = input.baseUrl;
  if (input.apiKey) fields.api_key = input.apiKey;
  if (input.systemPrompt !== undefined) fields.system_prompt = input.systemPrompt;
  if (input.kind !== undefined) fields.kind = input.kind;
  if (input.priority !== undefined) fields.priority = input.priority;
  if (input.enabled !== undefined) fields.enabled = input.enabled;
  if (input.contributor !== undefined) fields.contributor = input.contributor;
  if (input.contributorType !== undefined) fields.contributor_type = input.contributorType;

  const statements: LsqliteStatement[] = [update('providers', fields, whereEq({ id }))];
  if (input.models !== undefined) statements.push(...modelStatements(id, input.models));
  if (input.priority !== undefined) statements.push(...ensureGroupStatements(input.priority, now));

  await getDb().transaction(statements);
  return findProviderById(id);
}

export async function deleteProvider(id: number): Promise<void> {
  // provider_models 有 on delete cascade，但 Lsqlite 未必开启 foreign_keys pragma，
  // 因此显式删除关联行，避免遗留孤儿。
  await getDb().transaction([
    remove('provider_models', whereEq({ provider_id: id })),
    remove('providers', whereEq({ id })),
  ]);
}

function ensureGroupStatements(priority: number, now: string): LsqliteStatement[] {
  return [
    upsert(
      'priority_groups',
      { priority, rule: 'priority', timeout_ms: null, updated_at: now },
      { conflict: ['priority'] },
    ),
  ];
}

/** 组级规则与超时。修掉旧实现用 updateMany 把 rule 冗余写进组内每一行的做法。 */
export async function savePriorityGroup(
  priority: number,
  patch: { rule?: RoutingRule; timeoutMs?: number | null },
): Promise<void> {
  const now = new Date().toISOString();
  const values: Record<string, unknown> = {
    priority,
    rule: patch.rule ?? 'priority',
    timeout_ms: patch.timeoutMs ?? null,
    updated_at: now,
  };

  const set: string[] = ['updated_at'];
  if (patch.rule !== undefined) set.push('rule');
  if (patch.timeoutMs !== undefined) set.push('timeout_ms');

  await getDb().transaction([upsert('priority_groups', values, { conflict: ['priority'], set })]);
}

export async function listPriorityGroups(): Promise<Array<PriorityGroupRecord & { providerCount: number }>> {
  const rows = await getDb().select<{
    priority: number;
    rule: string;
    timeout_ms: number | null;
    provider_count: number;
  }>(
    `select g.priority, g.rule, g.timeout_ms,
            (select count(*) from providers p where p.priority = g.priority and p.kind = 'primary') as provider_count
       from priority_groups g
      order by g.priority asc`,
  );

  return rows.map((row) => ({
    priority: Number(row.priority),
    rule: normalizeRoutingRule(row.rule),
    timeoutMs: row.timeout_ms === null ? null : Number(row.timeout_ms),
    providerCount: Number(row.provider_count) || 0,
  }));
}

/** 删除没有任何 provider 的空组，避免后台出现悬空配置行 */
export async function pruneEmptyPriorityGroups(): Promise<void> {
  await getDb().execute(
    `delete from priority_groups
      where priority not in (select distinct priority from providers)`,
  );
}

export interface EnvProviderSpec {
  name: string;
  baseUrl: string;
  apiKey: string;
  systemPrompt?: string;
  models?: string[];
  rule?: string;
  priority?: number;
}

/**
 * 同步 FALLBACK_PROVIDERS。
 * 保持旧语义：env provider 可在后台停用（不强制恢复 enabled），
 * 从环境变量中移除后降级为 managed 而非删除。
 */
export async function syncEnvProviders(specs: EnvProviderSpec[]): Promise<void> {
  const now = new Date().toISOString();
  const envNames = new Set<string>();

  for (const spec of specs) {
    if (!spec.name || !spec.baseUrl || !spec.apiKey) {
      console.warn(`[Provider] skipping invalid env provider: ${spec.name || '(unnamed)'}`);
      continue;
    }
    envNames.add(spec.name);

    const existing = await findProviderByName(spec.name);
    const priority = spec.priority ?? 0;

    if (existing) {
      await updateProvider(existing.id, {
        baseUrl: spec.baseUrl,
        apiKey: spec.apiKey,
        systemPrompt: spec.systemPrompt,
        models: spec.models ?? [],
        priority,
      });
      await getDb().transaction([
        update('providers', { source: 'env', is_env: true, updated_at: now }, whereEq({ id: existing.id })),
      ]);
    } else {
      await createProvider({
        name: spec.name,
        baseUrl: spec.baseUrl,
        apiKey: spec.apiKey,
        systemPrompt: spec.systemPrompt,
        models: spec.models ?? [],
        source: 'env',
        priority,
        enabled: true,
      });
    }

    if (spec.rule) {
      await savePriorityGroup(priority, { rule: normalizeRoutingRule(spec.rule) });
    }
  }

  const envRows = await getDb().select<{ id: number; name: string }>(
    "select id, name from providers where source = 'env'",
  );
  const orphans = envRows.filter((row) => !envNames.has(row.name));

  if (orphans.length > 0) {
    await getDb().transaction(
      orphans.map((row) =>
        update('providers', { source: 'managed', is_env: false, updated_at: now }, whereEq({ id: row.id })),
      ),
    );
    for (const row of orphans) {
      console.log(`[Provider] "${row.name}" removed from env, downgraded to managed`);
    }
  }
}

/** 后台列表用：按来源与角色排序，便于前端分组展示 */
export async function listProviders(): Promise<ProviderRecord[]> {
  const rows = await getDb().select<ProviderRow>(
    `select ${PROVIDER_COLUMNS} from providers p
      order by case p.kind when 'primary' then 0 when 'parallel' then 1 else 2 end,
               p.priority asc, p.id asc`,
  );
  return rows.map(toProviderRecord);
}

/** 公开贡献列表，只取已验证通过的贡献记录 */
export async function listContributions(limit = 20): Promise<ProviderRecord[]> {
  const rows = await getDb().select<ProviderRow>(
    `select ${PROVIDER_COLUMNS} from providers p
      where p.source = 'contributed'
      order by p.updated_at desc
      limit ?`,
    [limit],
  );
  return rows.map(toProviderRecord);
}