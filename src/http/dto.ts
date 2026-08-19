/**
 * ProviderRecord -> ProviderDTO 映射。
 *
 * 唯一职责：确保 apiKey 永不出站。旧实现把 key 脱敏成 `sk-1***abcd` 返回前端，
 * 再靠「字符串是否包含 `***`」判断用户有没有改动 —— 用户真实 key 若含 `***`
 * 就会被误判为未改动。这里改为只暴露 `hasApiKey: boolean`，
 * 前端语义变为「留空即保持不变」，不再需要任何字符串启发式。
 */

import type { ProviderRecord } from '../db/repo/providers';
import { contributorAvatarUrl, contributorDisplayName } from '../core/contribution';
import type {
  ContributionListItemDTO,
  ContributorType,
  ProviderDTO,
  ProviderVariableDefinition,
  RoutingRule,
} from '../types/api';

function asContributorType(value: string | null): ContributorType | null {
  return value === 'email' || value === 'github' ? value : null;
}

function avatarOf(contributor: string | null, type: ContributorType | null): string | null {
  return contributor && type ? contributorAvatarUrl(contributor, type) : null;
}

function displayNameOf(record: ProviderRecord): string {
  const type = asContributorType(record.contributorType);
  if (!record.contributor || !type) return record.name;
  if (type === 'email') return record.contributor.split('@')[0] ?? record.name;
  return record.contributor;
}

function publicVariables(variables: ProviderVariableDefinition[]): ProviderVariableDefinition[] {
  return variables.map((variable) => {
    if (variable.type !== 'password') return variable;
    const configured = variable.secretConfigured ?? variable.defaultValue !== '';
    return { ...variable, defaultValue: '', secretConfigured: configured };
  });
}

export function toProviderDTO(record: ProviderRecord, effectiveRule: RoutingRule): ProviderDTO {
  const contributorType = asContributorType(record.contributorType);

  return {
    id: record.id,
    name: record.name,
    displayName: displayNameOf(record),
    baseUrl: record.baseUrl,
    hasApiKey: record.apiKey.length > 0,
    models: record.models,
    kind: record.kind,
    source: record.source,
    priority: record.priority,
    effectiveRule,
    enabled: record.enabled,
    contributor: record.contributor,
    contributorType,
    avatarUrl: avatarOf(record.contributor, contributorType),
    systemPrompt: record.systemPrompt,
    requestMode: record.requestMode,
    requestScript: record.requestScript,
    variables: publicVariables(record.variables),
    variablesAutoSync: record.variablesAutoSync,
    mainScript: record.mainScript,
    scheduleEnabled: record.scheduleEnabled,
    scheduleCron: record.scheduleCron,
    scheduleStatus: record.scheduleStatus,
    lastRunAt: record.lastRunAt,
    lastRunOk: record.lastRunOk,
    lastRunError: record.lastRunError,
    variablesUpdatedAt: record.variablesUpdatedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** 公开贡献列表：不含 apiKey，邮箱身份脱敏且不提供后缀，baseUrl 只保留 origin + pathname */
export function toContributionDTO(record: ProviderRecord): ContributionListItemDTO {
  const contributorType = asContributorType(record.contributorType) ?? 'github';
  const contributor = record.contributor ?? record.name;
  const publicContributor = contributorDisplayName(contributor, contributorType);

  return {
    id: record.id,
    name: record.name,
    contributor: publicContributor,
    contributorType,
    displayName: publicContributor,
    avatarUrl: avatarOf(record.contributor, contributorType),
    // 节点地址不进入公开 DTO。
    modelCount: record.models.length,
    models: record.models,
    enabled: record.enabled,
    updatedAt: record.updatedAt,
  };
}