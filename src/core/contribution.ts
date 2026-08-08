/**
 * 贡献者身份与提交内容的归一化 —— 纯函数。
 *
 * 旧实现把这些判别逻辑混在 routes/contributions.js 的请求处理里，
 * 与 SSRF 校验、上游验证、落库交织。这里剥离成可单测的纯逻辑，
 * 网络相关的部分（DNS 解析、上游探测）留在 http 层。
 */

import { createHash } from 'node:crypto';
import type { ContributorType } from '../types/api';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** GitHub 用户名：1-39 位，首尾字母数字，中间允许连字符 */
const GITHUB_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const QQ_MAIL_RE = /^([1-9]\d{4,11})@qq\.com$/;

const MAX_MODELS = 20;

export interface NormalizedContributor {
  contributor: string;
  contributorType: ContributorType;
  avatarUrl: string | null;
}

export class ValidationError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
  }
}

/** QQ 邮箱能推导出公开头像，其他邮箱与 GitHub ID 不推导（前端用首字母兜底） */
function qqAvatarUrl(email: string): string | null {
  const match = QQ_MAIL_RE.exec(email);
  if (!match) return null;
  return `https://q.qlogo.cn/headimg_dl?dst_uin=${match[1]}&spec=100`;
}

export function normalizeContributor(raw: unknown): NormalizedContributor {
  const value = String(raw ?? '').trim();
  if (!value) throw new ValidationError('邮箱或 GitHub 用户 ID 不能为空');

  const lowered = value.toLowerCase();
  if (EMAIL_RE.test(lowered)) {
    return { contributor: lowered, contributorType: 'email', avatarUrl: qqAvatarUrl(lowered) };
  }
  if (GITHUB_RE.test(value)) {
    return { contributor: value, contributorType: 'github', avatarUrl: null };
  }

  throw new ValidationError('请输入有效邮箱或 GitHub 用户 ID');
}

/** 接受数组或逗号/换行分隔字符串，去空去重并限制数量 */
export function normalizeModels(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw.map((item) => String(item ?? ''))
    : String(raw ?? '').split(/[,\n]/);

  const models = [...new Set(list.map((item) => item.trim()).filter(Boolean))].slice(0, MAX_MODELS);
  if (models.length === 0) throw new ValidationError('至少需要填写一个模型名');
  return models;
}

export function normalizeApiKey(raw: unknown): string {
  const value = String(raw ?? '').trim();
  if (!value) throw new ValidationError('API Key 不能为空');
  return value;
}

/** 同一 apiKey 稳定映射到同一 provider 名，使重复提交表现为更新而非新建 */
export function contributionProviderName(apiKey: string): string {
  return `contrib-${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;
}

/** 贡献列表对外只暴露 origin + pathname，隐去查询参数 */
export function maskBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return baseUrl;
  }
}

/**
 * 公开邮箱标识只保留首尾字符，中间按原长度替换为星号，并完全移除邮箱后缀。
 * 极短 ID 也至少隐藏一个字符，避免公开 DTO 可还原完整邮箱本地部分。
 */
export function contributorDisplayName(
  contributor: string,
  contributorType: ContributorType,
): string {
  if (contributorType !== 'email') return contributor;

  const local = contributor.split('@', 1)[0] ?? '';
  const characters = Array.from(local);
  if (characters.length <= 1) return '*';
  if (characters.length === 2) return `${characters[0]}*`;
  return `${characters[0]}${'*'.repeat(characters.length - 2)}${characters.at(-1)}`;
}