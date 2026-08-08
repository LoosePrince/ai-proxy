/**
 * 路由决策 —— 纯函数。
 *
 * 两层排序语义与旧实现保持一致：
 *   全局层：决定「先尝试哪个 priority 组」，规则来自 settings.globalRule
 *   组内层：决定「组内 provider 的尝试顺序」，规则来自 priority_groups.rule
 *
 * 与旧实现的差别：
 *   - 组内规则来自组实体，不再是「取组内第一个 provider 的 rule」
 *   - 特殊 provider（fallback/parallel）按 kind 区分，不再靠负 id / 魔法 priority
 *   - round-robin 的游标由调用方传入并返回，本模块不持有可变状态
 */

import type { ProviderRecord, PriorityGroupRecord } from '../db/repo/providers';
import type { RoutingRule } from '../types/api';

/** round-robin 游标读写。由 runtime/counters 提供实现，core 层保持无状态。 */
export interface RotationCursor {
  next(key: string): number;
}

export interface PriorityGroup {
  priority: number;
  rule: RoutingRule;
  timeoutMs: number | null;
  providers: ProviderRecord[];
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = result[i] as T;
    const b = result[j] as T;
    result[i] = b;
    result[j] = a;
  }
  return result;
}

function rotate<T>(items: T[], key: string, cursor: RotationCursor): T[] {
  if (items.length <= 1) return [...items];
  const offset = cursor.next(key) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

export function applyRule<T>(items: T[], rule: RoutingRule, key: string, cursor: RotationCursor): T[] {
  if (rule === 'random') return shuffle(items);
  if (rule === 'average') return rotate(items, key, cursor);
  return [...items];
}

function canonicalModelName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function modelBasename(value: string): string {
  return value.trim().split('/').filter(Boolean).at(-1) ?? value.trim();
}

function withoutVersionSuffix(value: string): string {
  return value.replace(/(?:latest|\d{8})$/i, '');
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[b.length] ?? Math.max(a.length, b.length);
}

/**
 * 模型名匹配分数。优先级依次为原名、忽略分隔符、忽略厂商前缀、前缀/后缀与轻微拼写差异。
 * 低于阈值即视为不同模型，防止“模糊匹配”扩散成任意模型路由。
 */
export function modelMatchScore(requested: string, available: string): number {
  const requestRaw = requested.trim().toLowerCase();
  const availableRaw = available.trim().toLowerCase();
  if (!requestRaw || !availableRaw) return 0;
  if (requestRaw === availableRaw) return 100;

  const requestCanonical = canonicalModelName(requestRaw);
  const availableCanonical = canonicalModelName(availableRaw);
  if (requestCanonical === availableCanonical) return 98;

  const requestBase = withoutVersionSuffix(canonicalModelName(modelBasename(requestRaw)));
  const availableBase = withoutVersionSuffix(canonicalModelName(modelBasename(availableRaw)));
  if (requestBase === availableBase) return 96;

  const shorter = requestBase.length <= availableBase.length ? requestBase : availableBase;
  const longer = requestBase.length > availableBase.length ? requestBase : availableBase;
  if (shorter.length >= 5 && longer.includes(shorter)) {
    return 80 + (shorter.length / longer.length) * 10;
  }

  const maxLength = Math.max(requestBase.length, availableBase.length);
  if (Math.min(requestBase.length, availableBase.length) < 6 || maxLength === 0) return 0;
  const similarity = 1 - editDistance(requestBase, availableBase) / maxLength;
  return similarity >= 0.8 ? 72 + similarity * 8 : 0;
}

function bestProviderModelScore(provider: ProviderRecord, requestedModel: string): number {
  // 未声明模型表示 provider 接受客户端模型透传。
  if (provider.models.length === 0) return 100;
  return Math.max(0, ...provider.models.map((model) => modelMatchScore(requestedModel, model)));
}

/**
 * 候选筛选：始终只考虑启用的 primary provider。
 * 指定模型时优先选择最接近的普通候选；没有达到阈值时退化为未指定模型的
 * 正常路由集合，而不是返回空链后提前触发昂贵的 fallback provider。
 */
export function selectCandidates(
  providers: ProviderRecord[],
  requestedModel: string | null,
): ProviderRecord[] {
  const primary = providers.filter((p) => p.kind === 'primary' && p.enabled);
  if (!requestedModel) return primary;

  const scored = primary.map((provider) => ({ provider, score: bestProviderModelScore(provider, requestedModel) }));
  const bestScore = Math.max(0, ...scored.map((item) => item.score));
  if (bestScore < 72) return primary;

  // 同一模型可能配置在多个 provider；保留同档最佳候选以继续应用组路由规则。
  return scored.filter((item) => item.score >= bestScore - 1).map((item) => item.provider);
}

export function groupByPriority(
  providers: ProviderRecord[],
  groupConfig: Map<number, PriorityGroupRecord>,
): PriorityGroup[] {
  const buckets = new Map<number, ProviderRecord[]>();

  for (const provider of providers) {
    const priority = Number.isFinite(provider.priority) ? provider.priority : 0;
    const bucket = buckets.get(priority);
    if (bucket) bucket.push(provider);
    else buckets.set(priority, [provider]);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([priority, items]) => {
      const config = groupConfig.get(priority);
      return {
        priority,
        rule: config?.rule ?? 'priority',
        timeoutMs: config?.timeoutMs ?? null,
        // 组内基准顺序固定为 id 升序，保证 priority 规则下结果稳定可复现
        providers: [...items].sort((a, b) => a.id - b.id),
      };
    });
}

function groupKey(groups: PriorityGroup[]): string {
  return groups.map((g) => `${g.priority}:${g.providers.map((p) => p.id).join(',')}`).join('|');
}

/**
 * 构建扁平尝试链。
 * 返回顺序即实际尝试顺序，调用方按 maxPrimaryAttempts 截断。
 */
export function buildAttemptChain(
  providers: ProviderRecord[],
  groupConfig: Map<number, PriorityGroupRecord>,
  requestedModel: string | null,
  globalRule: RoutingRule,
  cursor: RotationCursor,
): ProviderRecord[] {
  const candidates = selectCandidates(providers, requestedModel);
  if (candidates.length === 0) return [];

  const groups = groupByPriority(candidates, groupConfig);
  const orderedGroups = applyRule(groups, globalRule, `global:${groupKey(groups)}`, cursor);

  return orderedGroups.flatMap((group) =>
    applyRule(
      group.providers,
      group.rule,
      `group:${group.priority}:${group.providers.map((p) => p.id).join(',')}`,
      cursor,
    ),
  );
}

/**
 * 单个 provider 内的模型尝试顺序。
 * 请求模型若被该 provider 支持则顶到首位，其余按组规则排序后截断。
 */
export function buildModelCandidates(
  provider: ProviderRecord,
  requestedModel: string | null,
  rule: RoutingRule,
  cursor: RotationCursor,
  maxCount: number,
): string[] {
  const models = [...new Set(provider.models.map((m) => m.trim()).filter(Boolean))];

  /*
   * fallback 是主链全部失败后的独立末级资源，不参与客户端模型定向。
   * 即使客户端指定了模型，也按它自身的模型列表和组规则选择，避免把高价兜底
   * 当成某个普通模型的直达节点。parallel 仍需透传请求模型参与主链竞速。
   */
  if (requestedModel && provider.kind === 'parallel') return [requestedModel];

  // provider 未声明模型时，直接透传请求模型
  if (models.length === 0) {
    return requestedModel ? [requestedModel] : [];
  }

  const effectiveRequestedModel = provider.kind === 'fallback' ? null : requestedModel;

  if (effectiveRequestedModel) {
    const scored = models.map((model) => ({ model, score: modelMatchScore(effectiveRequestedModel, model) }));
    const bestScore = Math.max(0, ...scored.map((item) => item.score));
    if (bestScore >= 72) {
      const matched = scored.filter((item) => item.score >= bestScore - 1).map((item) => item.model);
      return applyRule(matched, rule, `models:${provider.id}:${matched.join(',')}`, cursor).slice(0, maxCount);
    }
  }

  // 未指定模型，或指定模型在当前 provider 无匹配时，走正常模型选择策略。
  return applyRule(models, rule, `models:${provider.id}:${models.join(',')}`, cursor).slice(0, maxCount);
}

export function findSpecialProvider(
  providers: ProviderRecord[],
  kind: 'fallback' | 'parallel',
): ProviderRecord | null {
  return providers.find((p) => p.kind === kind && p.enabled) ?? null;
}