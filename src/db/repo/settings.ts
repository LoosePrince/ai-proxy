/**
 * settings 仓储。
 *
 * 取代旧实现里 `stats.modelConfig` JSON 的读改写。全局配置现在是 key-value 行，
 * 单项更新互不覆盖，修掉了「并发改配置后写覆盖前写」的问题。
 *
 * 环境变量只作为首次初始化的种子值，之后一律以数据库为准，
 * 去掉旧实现 DB -> env -> 硬编码 三级 `??` 的语义混乱。
 */

import { getDb } from '../lsqlite';
import type { LsqliteStatement } from '../lsqlite';
import { upsert } from '../sql';
import type { RoutingRule, SettingsDTO, SettingsPatch } from '../../types/api';

const HARD_DEFAULTS: SettingsDTO = {
  globalRule: 'priority',
  defaultResponseTimeoutMs: 30_000,
  fallbackResponseTimeoutMs: 30_000,
  parallelTimeoutMs: 14_000,
  ipRateLimitRpm: 20,
  maxPrimaryAttempts: 3,
  maxModelRetryCount: 3,
  logRetentionDays: 0,
};

export function normalizeRoutingRule(value: unknown): RoutingRule {
  if (value === 'random') return 'random';
  // 兼容旧配置词汇
  if (value === 'average' || value === 'balanced') return 'average';
  return 'priority';
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.round(num) : fallback;
}

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return num <= 0 ? 0 : Math.round(num);
}

/** 原始 key-value 行 -> 强类型 DTO，逐项做范围校验 */
function toSettings(raw: Record<string, string>): SettingsDTO {
  const defaultTimeout = normalizePositiveInt(
    raw.defaultResponseTimeoutMs,
    HARD_DEFAULTS.defaultResponseTimeoutMs,
  );

  return {
    globalRule: normalizeRoutingRule(raw.globalRule),
    defaultResponseTimeoutMs: defaultTimeout,
    // 保底超时缺省时继承主路由超时，与旧行为一致
    fallbackResponseTimeoutMs: normalizePositiveInt(raw.fallbackResponseTimeoutMs, defaultTimeout),
    parallelTimeoutMs: normalizePositiveInt(raw.parallelTimeoutMs, HARD_DEFAULTS.parallelTimeoutMs),
    ipRateLimitRpm: normalizeNonNegativeInt(raw.ipRateLimitRpm, HARD_DEFAULTS.ipRateLimitRpm),
    maxPrimaryAttempts: normalizePositiveInt(raw.maxPrimaryAttempts, HARD_DEFAULTS.maxPrimaryAttempts),
    maxModelRetryCount: normalizePositiveInt(raw.maxModelRetryCount, HARD_DEFAULTS.maxModelRetryCount),
    logRetentionDays: normalizeNonNegativeInt(raw.logRetentionDays, HARD_DEFAULTS.logRetentionDays),
  };
}

export async function loadSettings(): Promise<SettingsDTO> {
  const rows = await getDb().select<{ key: string; value: string }>('select key, value from settings');
  const raw: Record<string, string> = {};
  for (const row of rows) raw[row.key] = row.value;
  return toSettings(raw);
}

function buildPatchStatements(patch: SettingsPatch): LsqliteStatement[] {
  const now = new Date().toISOString();

  return Object.entries(patch)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) =>
      upsert(
        'settings',
        { key, value: String(value), updated_at: now },
        { conflict: ['key'], set: ['value', 'updated_at'] },
      ),
    );
}

/** 只写入 patch 中出现的 key，未提及的配置保持不变 */
export async function saveSettings(patch: SettingsPatch): Promise<SettingsDTO> {
  const statements = buildPatchStatements(patch);
  if (statements.length > 0) await getDb().transaction(statements);
  return loadSettings();
}

function parsePriorityTimeoutEnv(value: string | undefined): Record<string, number> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const result: Record<string, number> = {};
    for (const [priority, ms] of Object.entries(parsed)) {
      const p = Number(priority);
      const t = Number(ms);
      if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) continue;
      result[String(p)] = Math.round(t);
    }
    return result;
  } catch (error) {
    console.warn(`[Settings] PRIORITY_RESPONSE_TIMEOUTS parse failed: ${(error as Error).message}`);
    return {};
  }
}

/**
 * 首次启动时用环境变量播种 settings 与 priority_groups。
 * 已存在的 key 不覆盖（`do nothing`），因此重启不会把后台改动冲回环境变量值。
 */
export async function seedSettingsFromEnv(): Promise<void> {
  const env = process.env;
  const now = new Date().toISOString();

  const seeds: Record<string, string | number> = {
    globalRule: HARD_DEFAULTS.globalRule,
    defaultResponseTimeoutMs: normalizePositiveInt(
      env.DEFAULT_RESPONSE_TIMEOUT_MS,
      HARD_DEFAULTS.defaultResponseTimeoutMs,
    ),
    fallbackResponseTimeoutMs: normalizePositiveInt(
      env.FALLBACK_RESPONSE_TIMEOUT_MS,
      HARD_DEFAULTS.fallbackResponseTimeoutMs,
    ),
    parallelTimeoutMs: normalizePositiveInt(env.PARALLEL_RESPONSE_TIMEOUT_MS, HARD_DEFAULTS.parallelTimeoutMs),
    ipRateLimitRpm: normalizeNonNegativeInt(env.IP_RATE_LIMIT_RPM, HARD_DEFAULTS.ipRateLimitRpm),
    maxPrimaryAttempts: HARD_DEFAULTS.maxPrimaryAttempts,
    maxModelRetryCount: HARD_DEFAULTS.maxModelRetryCount,
    logRetentionDays: normalizeNonNegativeInt(env.LOG_RETENTION_DAYS, HARD_DEFAULTS.logRetentionDays),
  };

  const statements: LsqliteStatement[] = Object.entries(seeds).map(([key, value]) =>
    upsert('settings', { key, value: String(value), updated_at: now }, { conflict: ['key'] }),
  );

  // PRIORITY_RESPONSE_TIMEOUTS 迁移到 priority_groups.timeout_ms
  for (const [priority, timeoutMs] of Object.entries(parsePriorityTimeoutEnv(env.PRIORITY_RESPONSE_TIMEOUTS))) {
    statements.push(
      upsert(
        'priority_groups',
        { priority: Number(priority), rule: 'priority', timeout_ms: timeoutMs, updated_at: now },
        { conflict: ['priority'] },
      ),
    );
  }

  await getDb().transaction(statements);
}

export { HARD_DEFAULTS as DEFAULT_SETTINGS };