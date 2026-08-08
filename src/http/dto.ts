/**
 * ProviderRecord -> ProviderDTO 映射。
 *
 * 唯一职责：确保 apiKey 永不出站。旧实现把 key 脱敏成 `sk-1***abcd` 返回前端，
 * 再靠「字符串是否包含 `***`」判断用户有没有改动 —— 用户真实 key 若含 `***`
 * 就会被误判为未改动。这里改为只暴露 `hasApiKey: boolean`，
 * 前端语义变为「留空即保持不变」，不再需要任何字符串启发式。
 */

import type { ProviderRecord } from '../db/repo/providers';
import { contributorDisplayName, maskBaseUrl } from '../core/contribution';
import type {
  ContributionListItemDTO,
  ContributorType,
  ProviderDTO,
  RoutingRule,
} from '../types/api';

function asContributorType(value: string | null): ContributorType | null {
  return value === 'email' || value === 'github' ? value : null;
}

/** QQ 邮箱可推导公开头像，其余返回 null 由前端用首字母兜底 */
function avatarOf(contributor: string | null, type: ContributorType | null): string | null {
  if (!contributor || type !== 'email') return null;
  const match = /^([1-9]\d{4,11})@qq\.com$/.exec(contributor);
  return match ? `https://q.qlogo.cn/headimg_dl?dst_uin=${match[1]}&spec=100` : null;
}

function displayNameOf(record: ProviderRecord): string {
  const type = asContributorType(record.contributorType);
  if (!record.contributor || !type) return record.name;
  if (type === 'email') return record.contributor.split('@')[0] ?? record.name;
  return record.contributor;
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
    // QQ 头像地址包含完整数字 ID，公开接口不能在脱敏后通过头像 URL 反向泄露。
    avatarUrl: contributorType === 'email' ? null : avatarOf(record.contributor, contributorType),
    baseUrl: maskBaseUrl(record.baseUrl),
    modelCount: record.models.length,
    models: record.models,
    enabled: record.enabled,
    updatedAt: record.updatedAt,
  };
}