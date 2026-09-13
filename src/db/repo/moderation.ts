/**
 * 内容审核仓储 —— 策略 / 类别 / 引擎 / 作用域绑定 / 审计事件的读写。
 *
 * 约定与其余仓储一致：
 *   - 结构化配置全部落独立表，不用 JSON blob
 *   - 远程 SQLite 不回传自增 id，插入后用唯一列（name）或时间戳回查
 *   - 写操作后由调用方 invalidateConfig() 使快照失效
 *
 * 审计事件不走本文件的写路径：它与请求明细同批写入，语句由
 * db/repo/requests.ts 的 buildIngestStatements 统一编译（保持单事务与零往返）。
 */

import { getDb } from '../lsqlite';
import type { LsqliteStatement } from '../lsqlite';
import type {
  MaliciousBehaviorAction,
  ModerationBindingDTO,
  ModerationCategory,
  ModerationCategorySettingDTO,
  ModerationCombineMode,
  ModerationDetectorSettingDTO,
  ModerationEventDTO,
  ModerationEventQuery,
  ModerationOutputAction,
  ModerationPolicyDTO,
  ModerationPolicyInput,
  ModerationScopeType,
  Paged,
} from '../../types/api';
import { MODERATION_CATEGORIES, categoryMeta } from '../../core/moderation/taxonomy';
import { materializeCategorySettings } from '../../core/moderation/compile';
import type { ModerationBindingRecord } from '../../core/moderation/compile';
import { MODERATION_DETECTORS } from '../../core/moderation/detectors';

interface PolicyRow {
  id: number;
  name: string;
  description: string;
  enabled: number;
  is_default: number;
  combine_mode: string;
  action: string;
  output_action: string;
  output_response: string;
  response: string;
  hold_back_chars: number;
  forbidden_keywords: string;
  created_at: string;
  updated_at: string;
}

interface CategoryRow {
  policy_id: number;
  category: string;
  enabled: number;
  sensitivity: number;
}

interface DetectorRow {
  policy_id: number;
  detector_id: string;
  enabled: number;
  categories_json: string;
}

function isCategory(value: unknown): value is ModerationCategory {
  return typeof value === 'string' && (MODERATION_CATEGORIES as readonly string[]).includes(value);
}

const COMBINE_MODES: readonly ModerationCombineMode[] = ['strict', 'majority', 'lenient'];
const OUTPUT_ACTIONS: readonly ModerationOutputAction[] = ['empty', 'error', 'response'];
const ACTIONS: readonly MaliciousBehaviorAction[] = ['ban', 'block', 'throttle', 'empty', 'error', 'response'];

function toPolicy(row: PolicyRow): Omit<ModerationPolicyDTO, 'categories' | 'detectors'> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    combineMode: COMBINE_MODES.includes(row.combine_mode as ModerationCombineMode)
      ? (row.combine_mode as ModerationCombineMode)
      : 'strict',
    action: ACTIONS.includes(row.action as MaliciousBehaviorAction)
      ? (row.action as MaliciousBehaviorAction)
      : 'empty',
    outputAction: OUTPUT_ACTIONS.includes(row.output_action as ModerationOutputAction)
      ? (row.output_action as ModerationOutputAction)
      : 'empty',
    outputResponse: row.output_response,
    response: row.response,
    holdBackChars: row.hold_back_chars,
    forbiddenKeywords: row.forbidden_keywords,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseCategoriesJson(value: string): ModerationCategory[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCategory);
  } catch {
    return [];
  }
}

export interface ModerationSnapshot {
  policies: ModerationPolicyDTO[];
  bindings: ModerationBindingRecord[];
}

function toPolicyDto(
  row: PolicyRow,
  categoryRows: CategoryRow[],
  detectorRows: DetectorRow[],
): ModerationPolicyDTO {
  const base = toPolicy(row);
  const stored = new Map<ModerationCategory, ModerationCategorySettingDTO>();
  for (const category of categoryRows) {
    if (category.policy_id !== row.id || !isCategory(category.category)) continue;
    stored.set(category.category, {
      category: category.category,
      enabled: category.enabled === 1,
      sensitivity: category.sensitivity,
    });
  }

  // 库里存的是完整矩阵；缺失时按默认补齐，保证后台展示稳定
  const categories = materializeCategorySettings([...stored.values()]);

  const detectors: ModerationDetectorSettingDTO[] =
    detectorRows.length > 0
      ? detectorRows
          .filter((detector) => detector.policy_id === row.id)
          .map((detector) => ({
            detectorId: detector.detector_id,
            enabled: detector.enabled === 1,
            categories: parseCategoriesJson(detector.categories_json),
          }))
      : defaultDetectorSettings();

  return { ...base, categories, detectors };
}

/** 新策略的默认引擎集合：内置词库与 whitz 原生分类，其余按可达类别归属 */
export function defaultDetectorSettings(): ModerationDetectorSettingDTO[] {
  return MODERATION_DETECTORS.map((detector) => ({
    detectorId: detector.id,
    enabled: true,
    categories: detector.nativeCategories ? [] : genericAttributeCategories(detector.id),
  }));
}

/**
 * 通用命中引擎的默认归属类别。
 *
 * 刻意只给 profanity：这些库无法区分「脏话」与「仇恨/色情」，
 * 若默认映射到 sexual / hate，会把普通脏话误标成严重类别。
 * 需要更精细归属时由管理员在审核页按引擎自行勾选。
 */
function genericAttributeCategories(detectorId: string): ModerationCategory[] {
  if (detectorId === 'obscenity' || detectorId === 'visulima') return ['profanity'];
  return [];
}

export async function loadModerationSnapshot(): Promise<ModerationSnapshot> {
  const db = getDb();
  const [policies, categories, detectors, bindings] = await Promise.all([
    db.select<PolicyRow>(
      `select id, name, description, enabled, is_default, combine_mode, action, output_action,
              output_response, response, hold_back_chars, forbidden_keywords, created_at, updated_at
       from moderation_policies order by is_default desc, id asc`,
    ),
    db.select<CategoryRow>('select policy_id, category, enabled, sensitivity from moderation_policy_categories'),
    db.select<DetectorRow>('select policy_id, detector_id, enabled, categories_json from moderation_policy_detectors'),
    db.select<{ id: number; scope_type: string; provider_id: number | null; model: string | null; policy_id: number }>(
      'select id, scope_type, provider_id, model, policy_id from moderation_bindings',
    ),
  ]);

  return {
    policies: policies.map((row) => toPolicyDto(row, categories, detectors)),
    bindings: bindings
      .filter((row) => row.scope_type === 'provider' || row.scope_type === 'model')
      .map((row) => ({
        scopeType: row.scope_type as 'provider' | 'model',
        providerId: row.provider_id,
        model: row.model,
        policyId: row.policy_id,
      })),
  };
}

export async function listModerationPolicies(): Promise<ModerationPolicyDTO[]> {
  const snapshot = await loadModerationSnapshot();
  return snapshot.policies;
}

export async function findModerationPolicyById(id: number): Promise<ModerationPolicyDTO | null> {
  const db = getDb();
  const row = await db.selectOne<PolicyRow>(
    `select id, name, description, enabled, is_default, combine_mode, action, output_action,
            output_response, response, hold_back_chars, forbidden_keywords, created_at, updated_at
     from moderation_policies where id = ?`,
    [id],
  );
  if (!row) return null;
  const [categories, detectors] = await Promise.all([
    db.select<CategoryRow>(
      'select policy_id, category, enabled, sensitivity from moderation_policy_categories where policy_id = ?',
      [id],
    ),
    db.select<DetectorRow>(
      'select policy_id, detector_id, enabled, categories_json from moderation_policy_detectors where policy_id = ?',
      [id],
    ),
  ]);
  return toPolicyDto(row, categories, detectors);
}

function categoryStatements(policyId: number, categories: ModerationCategorySettingDTO[]): LsqliteStatement[] {
  return materializeCategorySettings(categories).map((setting) => ({
    sql: `insert into moderation_policy_categories (policy_id, category, enabled, sensitivity)
          values (?, ?, ?, ?)
          on conflict (policy_id, category) do update set enabled = excluded.enabled, sensitivity = excluded.sensitivity`,
    params: [policyId, setting.category, setting.enabled ? 1 : 0, setting.sensitivity],
    mode: 'write' as const,
  }));
}

function detectorStatements(policyId: number, detectors: ModerationDetectorSettingDTO[]): LsqliteStatement[] {
  return detectors.map((setting) => ({
    sql: `insert into moderation_policy_detectors (policy_id, detector_id, enabled, categories_json)
          values (?, ?, ?, ?)
          on conflict (policy_id, detector_id) do update set enabled = excluded.enabled, categories_json = excluded.categories_json`,
    params: [policyId, setting.detectorId, setting.enabled ? 1 : 0, JSON.stringify(setting.categories ?? [])],
    mode: 'write' as const,
  }));
}

/** 强制唯一默认策略：设置 is_default 时先清空其他行 */
function clearDefaultStatements(exceptId?: number): LsqliteStatement[] {
  return [
    {
      sql: 'update moderation_policies set is_default = 0 where is_default = 1 and id != ?',
      params: [exceptId ?? -1],
      mode: 'write',
    },
  ];
}

export type ModerationPolicyWriteInput = ModerationPolicyInput;

export async function createModerationPolicy(input: ModerationPolicyWriteInput): Promise<ModerationPolicyDTO> {
  const db = getDb();
  const now = new Date().toISOString();
  const statements: LsqliteStatement[] = [
    {
      sql: `insert into moderation_policies
              (name, description, enabled, is_default, combine_mode, action, output_action,
               output_response, response, hold_back_chars, forbidden_keywords, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        input.name,
        input.description ?? '',
        input.enabled === false ? 0 : 1,
        input.isDefault ? 1 : 0,
        input.combineMode ?? 'strict',
        input.action ?? 'empty',
        input.outputAction ?? 'empty',
        input.outputResponse ?? '',
        input.response ?? '',
        input.holdBackChars ?? 96,
        input.forbiddenKeywords ?? '',
        now,
        now,
      ],
      mode: 'write',
    },
  ];
  if (input.isDefault) statements.unshift(...clearDefaultStatements());

  await db.transaction(statements);
  const row = await db.selectOne<PolicyRow>('select id from moderation_policies where name = ?', [input.name]);
  if (!row) throw new Error('审核策略写入后未找到记录');

  const statements2: LsqliteStatement[] = [
    ...categoryStatements(row.id, input.categories ?? []),
    ...detectorStatements(row.id, input.detectors ?? defaultDetectorSettings()),
  ];
  if (statements2.length > 0) await db.transaction(statements2);

  const created = await findModerationPolicyById(row.id);
  if (!created) throw new Error('审核策略写入后读取失败');
  return created;
}

export async function updateModerationPolicy(
  id: number,
  input: Partial<ModerationPolicyInput>,
): Promise<ModerationPolicyDTO | null> {
  const db = getDb();
  const existing = await findModerationPolicyById(id);
  if (!existing) return null;

  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown): void => {
    sets.push(`${column} = ?`);
    params.push(value);
  };

  if (input.name !== undefined) push('name', input.name);
  if (input.description !== undefined) push('description', input.description);
  if (input.enabled !== undefined) push('enabled', input.enabled ? 1 : 0);
  if (input.isDefault !== undefined) push('is_default', input.isDefault ? 1 : 0);
  if (input.combineMode !== undefined) push('combine_mode', input.combineMode);
  if (input.action !== undefined) push('action', input.action);
  if (input.outputAction !== undefined) push('output_action', input.outputAction);
  if (input.outputResponse !== undefined) push('output_response', input.outputResponse);
  if (input.response !== undefined) push('response', input.response);
  if (input.holdBackChars !== undefined) push('hold_back_chars', input.holdBackChars);
  if (input.forbiddenKeywords !== undefined) push('forbidden_keywords', input.forbiddenKeywords);

  const statements: LsqliteStatement[] = [];
  if (input.isDefault === true) statements.push(...clearDefaultStatements(id));
  if (sets.length > 0) {
    push('updated_at', new Date().toISOString());
    params.push(id);
    statements.push({
      sql: `update moderation_policies set ${sets.join(', ')} where id = ?`,
      params,
      mode: 'write',
    });
  }

  if (input.categories) statements.push(...categoryStatements(id, input.categories));
  if (input.detectors) {
    statements.push({
      sql: 'delete from moderation_policy_detectors where policy_id = ?',
      params: [id],
      mode: 'write',
    });
    statements.push(...detectorStatements(id, input.detectors));
  }

  if (statements.length > 0) await db.transaction(statements);
  return findModerationPolicyById(id);
}

export async function deleteModerationPolicy(id: number): Promise<boolean> {
  const db = getDb();
  const existing = await findModerationPolicyById(id);
  if (!existing) return false;
  await db.transaction([
    { sql: 'delete from moderation_policy_categories where policy_id = ?', params: [id], mode: 'write' },
    { sql: 'delete from moderation_policy_detectors where policy_id = ?', params: [id], mode: 'write' },
    { sql: 'delete from moderation_bindings where policy_id = ?', params: [id], mode: 'write' },
    { sql: 'delete from moderation_policies where id = ?', params: [id], mode: 'write' },
  ]);
  return true;
}

// ------------------------------------------------------------------ 绑定

export async function listModerationBindings(): Promise<ModerationBindingDTO[]> {
  const rows = await getDb().select<{
    id: number;
    scope_type: string;
    provider_id: number | null;
    provider_name: string | null;
    model: string | null;
    policy_id: number;
    policy_name: string | null;
    created_at: string;
  }>(
    `select b.id, b.scope_type, b.provider_id, p.name as provider_name, b.model, b.policy_id,
            mp.name as policy_name, b.created_at
     from moderation_bindings b
     left join providers p on p.id = b.provider_id
     left join moderation_policies mp on mp.id = b.policy_id
     order by b.scope_type asc, b.id asc`,
  );

  return rows.map((row) => ({
    id: row.id,
    scopeType: (row.scope_type === 'model' ? 'model' : 'provider') as ModerationScopeType,
    providerId: row.provider_id,
    providerName: row.provider_name,
    model: row.model,
    policyId: row.policy_id,
    policyName: row.policy_name,
    createdAt: row.created_at,
  }));
}

/** 同作用域只保留一条：先删后插，避免依赖部分唯一索引的 upsert 语法 */
export async function upsertModerationBinding(input: {
  scopeType: ModerationScopeType;
  providerId: number;
  model: string | null;
  policyId: number;
}): Promise<void> {
  const now = new Date().toISOString();
  const statements: LsqliteStatement[] = [];

  if (input.scopeType === 'provider') {
    statements.push({
      sql: `delete from moderation_bindings where scope_type = 'provider' and provider_id = ?`,
      params: [input.providerId],
      mode: 'write',
    });
  } else {
    statements.push({
      sql: `delete from moderation_bindings where scope_type = 'model' and provider_id = ? and model = ?`,
      params: [input.providerId, input.model ?? ''],
      mode: 'write',
    });
  }

  statements.push({
    sql: `insert into moderation_bindings (scope_type, provider_id, model, policy_id, created_at)
          values (?, ?, ?, ?, ?)`,
    params: [
      input.scopeType,
      input.providerId,
      input.scopeType === 'model' ? input.model ?? '' : null,
      input.policyId,
      now,
    ],
    mode: 'write',
  });

  await getDb().transaction(statements);
}

export async function deleteModerationBinding(id: number): Promise<boolean> {
  const result = await getDb().execute('delete from moderation_bindings where id = ?', [id]);
  return (result.rowCount ?? 0) > 0;
}

// ------------------------------------------------------------------ 审计

interface ModerationEventRow {
  id: number;
  trace_id: string;
  occurred_at: string;
  stage: string;
  categories: string;
  detector_ids: string;
  score: number | null;
  matched: string;
  action: string;
  blocked: number;
  ip: string | null;
  policy_id: number | null;
  policy_name: string | null;
  provider_name: string | null;
  model: string | null;
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function toEventDto(row: ModerationEventRow): ModerationEventDTO {
  return {
    id: row.id,
    traceId: row.trace_id,
    occurredAt: row.occurred_at,
    stage: row.stage === 'output' ? 'output' : 'input',
    categories: splitList(row.categories).filter(isCategory),
    detectorIds: splitList(row.detector_ids),
    score: row.score === null ? null : Number(row.score),
    matched: splitList(row.matched),
    action: row.action,
    blocked: row.blocked === 1,
    ip: row.ip,
    policyId: row.policy_id,
    policyName: row.policy_name,
    providerName: row.provider_name,
    model: row.model,
  };
}

export async function queryModerationEvents(query: ModerationEventQuery = {}): Promise<Paged<ModerationEventDTO>> {
  const db = getDb();
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);

  const parts: string[] = [];
  const params: unknown[] = [];
  if (query.stage) {
    parts.push('stage = ?');
    params.push(query.stage);
  }
  if (query.blockedOnly) parts.push('blocked = 1');
  if (query.category) {
    parts.push(`(categories = ? or categories like ? or categories like ? or categories like ?)`);
    params.push(query.category, `${query.category},%`, `%, ${query.category}`, `%, ${query.category},%`);
  }
  if (query.from) {
    parts.push('occurred_at >= ?');
    params.push(query.from);
  }
  if (query.to) {
    parts.push('occurred_at <= ?');
    params.push(query.to);
  }
  const where = parts.length ? `where ${parts.join(' and ')}` : '';

  const [rows, countRow] = await Promise.all([
    db.select<ModerationEventRow>(
      `select id, trace_id, occurred_at, stage, categories, detector_ids, score, matched, action,
              blocked, ip, policy_id, policy_name, provider_name, model
       from moderation_events ${where} order by occurred_at desc, id desc limit ? offset ?`,
      [...params, limit, offset],
    ),
    db.selectOne<{ total: number }>(`select count(*) as total from moderation_events ${where}`, params),
  ]);

  return { items: rows.map(toEventDto), total: countRow?.total ?? 0, limit, offset };
}

export async function pruneOldModerationEvents(retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const result = await getDb().execute('delete from moderation_events where occurred_at < ?', [cutoff]);
  return result.rowCount ?? 0;
}

// ------------------------------------------------------------------ 种子

/**
 * 首次启动写一条默认策略。已存在任何策略时不动，重启不会覆盖后台改动。
 * 类别按 taxonomy 的默认敏感度全部启用，引擎走 defaultDetectorSettings()。
 */
export async function seedModerationDefaults(): Promise<void> {
  const db = getDb();
  const existing = await db.selectOne<{ total: number }>('select count(*) as total from moderation_policies');
  if ((existing?.total ?? 0) > 0) return;

  try {
    await createSeededDefault();
    console.log('[Moderation] seeded default policy');
  } catch (error) {
    // 多实例同时启动时另一个实例可能已经播种（name 唯一约束），忽略即可
    console.warn(`[Moderation] seed skipped: ${(error as Error).message}`);
  }
}

async function createSeededDefault(): Promise<void> {
  await createModerationPolicy({
    name: '默认策略',
    description: '首次启动自动创建：全部类别按默认敏感度启用，多引擎 strict 组合。',
    enabled: true,
    isDefault: true,
    combineMode: 'strict',
    action: 'empty',
    outputAction: 'empty',
    outputResponse: '抱歉，该回复因安全策略被拦截。',
    response: '',
    holdBackChars: 96,
    forbiddenKeywords: '',
    categories: MODERATION_CATEGORIES.map((category) => ({
      category,
      enabled: true,
      sensitivity: categoryMeta(category).defaultSensitivity,
    })),
    detectors: defaultDetectorSettings(),
  });
}
