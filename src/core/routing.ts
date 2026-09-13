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
import type { ModelHealthRoutingMode, RoutingRule } from '../types/api';

/**
 * 模型健康态（渠道声明模型粒度）。由 runtime/model-health 提供，core 层保持无状态。
 * coolingDown=true 的模型在候选里被视为不可用。
 */
export interface ModelHealthProbe {
  state: 'ok' | 'down' | 'idle';
  coolingDown: boolean;
}

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

export function byHealthPreference<T>(
  items: T[],
  stateOf: (item: T) => 'ok' | 'down' | 'idle',
): T[] {
  const rank = { down: 0, idle: 1, ok: 2 } as const;
  return items
    .map((item, index) => ({ item, index, rank: rank[stateOf(item)] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.item);
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
 *
 * fuzzy=false 时只认完全一致的模型 ID（大小写不敏感），关闭相近匹配能力。
 */
export function modelMatchScore(requested: string, available: string, fuzzy = true): number {
  const requestRaw = requested.trim().toLowerCase();
  const availableRaw = available.trim().toLowerCase();
  if (!requestRaw || !availableRaw) return 0;
  if (requestRaw === availableRaw) return 100;
  if (!fuzzy) return 0;

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

function bestProviderModelScore(provider: ProviderRecord, requestedModel: string, fuzzy: boolean): number {
  // 配置了不参与模型匹配的 Provider（或其全部模型）永远不被模型匹配选中，只能被正常路由命中。
  if (provider.excludeFromModelMatching) return 0;
  // 未声明模型表示 provider 接受客户端模型透传。
  if (provider.models.length === 0) return 100;
  const matchable = provider.models.filter((model) => !provider.modelMatchExcludeModels.includes(model));
  if (matchable.length === 0) return 0;
  return Math.max(0, ...matchable.map((model) => modelMatchScore(requestedModel, model, fuzzy)));
}

/**
 * 候选筛选只负责找出指定模型的最佳匹配 Provider。
 * 没有指定模型、关闭相近匹配、或没有达到匹配阈值时返回全部启用的 primary Provider。
 * 配置了不参与模型匹配的 Provider 不会出现在匹配结果里，但保留在正常路由中。
 *
 * 注意：这里的匹配结果只用于“优先尝试谁”，不能作为完整主链；否则最佳
 * Provider 失败后会跳过其余正常路由，直接落到 fallback。
 */
export function selectCandidates(
  providers: ProviderRecord[],
  requestedModel: string | null,
  fuzzy = true,
): ProviderRecord[] {
  const primary = providers.filter((p) => p.kind === 'primary' && p.enabled);
  // 关闭相近匹配 = 不处理请求中的模型 id，按未传模型处理
  if (!requestedModel || !fuzzy) return primary;

  const scored = primary
    .filter((provider) => !provider.excludeFromModelMatching)
    .map((provider) => ({ provider, score: bestProviderModelScore(provider, requestedModel, fuzzy) }));
  const bestScore = Math.max(0, ...scored.map((item) => item.score));
  if (bestScore < 72) return primary;

  // 同一模型可能配置在多个 provider；保留同档最佳候选。
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
 * 构建完整主路由尝试链。
 *
 * 所有启用的 primary Provider 都先按全局和组内规则排序；指定模型的最佳匹配
 * 只提升到链首，不会删除其余 Provider。这样首选模型失败后仍会继续正常的
 * priority/random/average 路由，调用方最后再按 maxPrimaryAttempts 截断。
 */
export function buildAttemptChain(
  providers: ProviderRecord[],
  groupConfig: Map<number, PriorityGroupRecord>,
  requestedModel: string | null,
  globalRule: RoutingRule,
  cursor: RotationCursor,
  fuzzy = true,
): ProviderRecord[] {
  const primary = providers.filter((provider) => provider.kind === 'primary' && provider.enabled);
  if (primary.length === 0) return [];

  const groups = groupByPriority(primary, groupConfig);
  const orderedGroups = applyRule(groups, globalRule, `global:${groupKey(groups)}`, cursor);
  const ordered = orderedGroups.flatMap((group) =>
    applyRule(
      group.providers,
      group.rule,
      `group:${group.priority}:${group.providers.map((p) => p.id).join(',')}`,
      cursor,
    ),
  );

  // 关闭相近匹配 = 不处理请求中的模型 id，按未传模型处理（不做任何模型优先）
  if (!requestedModel || !fuzzy) return ordered;
  const preferredIds = new Set(selectCandidates(primary, requestedModel, fuzzy).map((provider) => provider.id));
  if (preferredIds.size === primary.length) return ordered;

  return [
    ...ordered.filter((provider) => preferredIds.has(provider.id)),
    ...ordered.filter((provider) => !preferredIds.has(provider.id)),
  ];
}

/**
 * 构建特殊 Provider 链。多个 fallback 按与主链相同的全局/组内规则排序，
 * 代理层可以依次失败转移，不再只取数据库顺序中的第一项。
 */
export function buildSpecialProviderChain(
  providers: ProviderRecord[],
  groupConfig: Map<number, PriorityGroupRecord>,
  kind: 'fallback' | 'parallel',
  globalRule: RoutingRule,
  cursor: RotationCursor,
): ProviderRecord[] {
  const enabled = providers.filter((provider) => provider.kind === kind && provider.enabled);
  if (enabled.length === 0) return [];

  const groups = groupByPriority(enabled, groupConfig);
  const orderedGroups = applyRule(groups, globalRule, `${kind}:global:${groupKey(groups)}`, cursor);
  return orderedGroups.flatMap((group) =>
    applyRule(
      group.providers,
      group.rule,
      `${kind}:group:${group.priority}:${group.providers.map((provider) => provider.id).join(',')}`,
      cursor,
    ),
  );
}

/**
 * 单个 provider 内的模型尝试顺序。
 * 请求模型若被该 provider 支持则顶到首位，其余按组规则排序后截断。
 *
 * healthOf（可选）提供渠道声明模型的实时健康：冷却中的模型直接剔除；
 * mode 按设置项决定是否把异常/无流量模型前置（默认 random 不干预排序）。
 */
export function buildModelCandidates(
  provider: ProviderRecord,
  requestedModel: string | null,
  rule: RoutingRule,
  cursor: RotationCursor,
  maxCount: number,
  fuzzy = true,
  options?: {
    mode?: ModelHealthRoutingMode;
    healthOf?: (model: string) => ModelHealthProbe;
  },
): string[] {
  const usable = (model: string): boolean => options?.healthOf?.(model).coolingDown !== true;
  const models = [...new Set(provider.models.map((m) => m.trim()).filter(Boolean))]
    // 渠道弹窗里被停用的模型：路由视为无该模型，冷却中的模型同样不可选
    .filter(usable);

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
  /*
   * 满足以下条件才尝试把请求模型映射到 provider 的模型：
   *   - 相近匹配开关开启（关闭 = 不处理模型 id，按未传模型处理）
   *   - 该 Provider 未被配置为不参与模型匹配
   *   - 还存在未被排除的模型可参与匹配
   * 被排除的模型不会被匹配选中，但仍可被正常策略（priority/random/average）命中。
   */
  const matchableModels = models.filter((model) => !provider.modelMatchExcludeModels.includes(model));
  const canMatch =
    !!effectiveRequestedModel && fuzzy && !provider.excludeFromModelMatching && matchableModels.length > 0;

  // 健康感知只在按组规则选出顺序之后做一次重排，不影响匹配语义
  const applyHealthOrder = (list: string[]): string[] => {
    const mode = options?.mode ?? 'random';
    if (mode === 'random' || !options?.healthOf || list.length <= 1) return list;
    return byHealthPreference(list, (model) => options.healthOf!(model).state);
  };

  if (canMatch) {
    const scored = matchableModels.filter(usable).map((model) => ({
      model,
      score: modelMatchScore(effectiveRequestedModel, model, fuzzy),
    }));
    const bestScore = Math.max(0, ...scored.map((item) => item.score));
    if (bestScore >= 72) {
      const matched = scored.filter((item) => item.score >= bestScore - 1).map((item) => item.model);
      return applyHealthOrder(
        applyRule(matched, rule, `models:${provider.id}:${matched.join(',')}`, cursor),
      ).slice(0, maxCount);
    }
  }

  // 未指定模型、关闭相近匹配、Provider 被排除、或指定模型在匹配池中无命中时，
  // 走正常模型选择策略（被排除的模型仍可能在这里被随机/轮转命中）。
  return applyHealthOrder(
    applyRule(models, rule, `models:${provider.id}:${models.join(',')}`, cursor),
  ).slice(0, maxCount);
}

export function findSpecialProvider(
  providers: ProviderRecord[],
  kind: 'fallback' | 'parallel',
): ProviderRecord | null {
  return providers.find((p) => p.kind === kind && p.enabled) ?? null;
}