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

/**
 * 候选筛选：指定模型时优先取支持该模型的 provider；
 * 无人支持则回退到全部 primary provider，与旧行为一致。
 */
export function selectCandidates(
  providers: ProviderRecord[],
  requestedModel: string | null,
): ProviderRecord[] {
  const primary = providers.filter((p) => p.kind === 'primary' && p.enabled);
  if (!requestedModel) return primary;

  const matched = primary.filter((p) => p.models.includes(requestedModel));
  return matched.length > 0 ? matched : primary;
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

  // provider 未声明模型时，直接透传请求模型
  if (models.length === 0) {
    return requestedModel ? [requestedModel] : [];
  }

  const ordered = applyRule(models, rule, `models:${provider.id}:${models.join(',')}`, cursor);

  if (requestedModel && models.includes(requestedModel)) {
    return [requestedModel, ...ordered.filter((m) => m !== requestedModel)].slice(0, maxCount);
  }

  return ordered.slice(0, maxCount);
}

export function findSpecialProvider(
  providers: ProviderRecord[],
  kind: 'fallback' | 'parallel',
): ProviderRecord | null {
  return providers.find((p) => p.kind === kind && p.enabled) ?? null;
}