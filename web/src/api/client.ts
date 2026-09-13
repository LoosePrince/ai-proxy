/**
 * 统一 API 客户端。
 *
 * 职责边界：只做「请求 -> 类型化结果 或 抛出 ApiError」这一件事。
 * 页面层不再各自 try/catch + 手搓 res.ok 判断（旧 admin.html 里每处调用
 * 都重复一遍错误分支，且错误体格式不一致）。
 *
 * 后端错误体统一为 { error: { message, code? } }，这里归一化成 ApiError。
 */

import type {
  AnnouncementDTO,
  AnnouncementInput,
  AuthStateDTO,
  ChannelModelHealthDTO,
  ContributionListItemDTO,
  ContributionSubmitInput,
  ContributionSubmitResult,
  DashboardSummaryDTO,
  EndpointHealthDTO,
  IpBlacklistDTO,
  IpDetailStatsDTO,
  IpUsageDTO,
  ModelUsageDTO,
  ModerationBindingDTO,
  ModerationBindingInput,
  ModerationCategory,
  ModerationDetectorInfoDTO,
  ModerationEventDTO,
  ModerationEventQuery,
  ModerationPolicyDTO,
  ModerationPolicyInput,
  Paged,
  PriorityGroupDTO,
  ProviderDTO,
  ProviderUpsertInput,
  ProviderTestInput,
  ProviderTestResult,
  ProviderUsageDTO,
  PublicDetailedStatsDTO,
  PublicSiteConfigDTO,
  PublicStatsDTO,
  RequestDetailDTO,
  RequestListQuery,
  RequestSummaryDTO,
  RoutingRule,
  SettingsDTO,
  SettingsPatch,
  UsageDailyDTO,
} from '@shared/api';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** 贡献提交失败时后端会带回逐模型结果，这里原样保留供页面回显 */
  readonly payload: unknown;

  constructor(message: string, status: number, code: string | null = null, payload: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

interface ErrorBody {
  error?: { message?: string; code?: string } | string;
}

async function parseError(response: Response): Promise<ApiError> {
  let body: ErrorBody | null = null;
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    // 上游返回了非 JSON（如反代的 HTML 错误页），退回状态码文本
  }

  const raw = body?.error;
  const message =
    (typeof raw === 'string' ? raw : raw?.message) || `请求失败（HTTP ${response.status}）`;
  const code = typeof raw === 'object' && raw?.code ? raw.code : null;

  return new ApiError(message, response.status, code, body);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    // admin 走 session cookie，必须带凭据
    credentials: 'same-origin',
  });

  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;

  return (await response.json()) as T;
}

function toQuery(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

// ------------------------------------------------------------------ 公开接口

export type PublicAnnouncementDTO = Omit<AnnouncementDTO, 'enabled'>;

export const publicApi = {
  siteConfig: () => request<PublicSiteConfigDTO>('/api/site-config'),

  announcements: () => request<PublicAnnouncementDTO[]>('/api/announcements'),

  stats: () => request<PublicStatsDTO>('/api/public-stats'),

  detailedStats: () => request<PublicDetailedStatsDTO>('/api/public-stats/detailed'),

  contributions: () => request<ContributionListItemDTO[]>('/api/contributions'),

  submitContribution: (input: ContributionSubmitInput) =>
    request<ContributionSubmitResult>('/api/contributions', { method: 'POST', ...json(input) }),

  models: () => request<{ data: Array<{ id: string }> }>('/v1/models'),
};

// ------------------------------------------------------------------ 后台接口

export const adminApi = {
  authCheck: () => request<AuthStateDTO>('/admin/api/auth-check'),

  login: (username: string, password: string) =>
    request<{ success: boolean }>('/admin/api/login', { method: 'POST', ...json({ username, password }) }),

  logout: () => request<{ success: boolean }>('/admin/api/logout', { method: 'POST' }),

  announcements: () => request<AnnouncementDTO[]>('/admin/api/announcements'),

  createAnnouncement: (input: AnnouncementInput) =>
    request<AnnouncementDTO>('/admin/api/announcements', { method: 'POST', ...json(input) }),

  updateAnnouncement: (id: number, patch: Partial<AnnouncementInput>) =>
    request<AnnouncementDTO>(`/admin/api/announcements/${id}`, { method: 'PUT', ...json(patch) }),

  deleteAnnouncement: (id: number) =>
    request<{ success: boolean }>(`/admin/api/announcements/${id}`, { method: 'DELETE' }),

  providers: () => request<ProviderDTO[]>('/admin/api/providers'),

  createProvider: (input: ProviderUpsertInput) =>
    request<ProviderDTO>('/admin/api/providers', { method: 'POST', ...json(input) }),

  updateProvider: (id: number, input: Partial<ProviderUpsertInput>) =>
    request<ProviderDTO>(`/admin/api/providers/${id}`, { method: 'PUT', ...json(input) }),

  testProvider: (input: ProviderTestInput & { providerId?: number; provider: ProviderUpsertInput }) =>
    request<ProviderTestResult>('/admin/api/providers/test', { method: 'POST', ...json(input) }),

  runProviderMain: (id: number) =>
    request<{ success: boolean; updated: string[] }>(`/admin/api/providers/${id}/main/run`, { method: 'POST' }),

  deleteProvider: (id: number) =>
    request<{ success: boolean }>(`/admin/api/providers/${id}`, { method: 'DELETE' }),

  priorityGroups: () => request<PriorityGroupDTO[]>('/admin/api/priority-groups'),

  savePriorityGroup: (priority: number, patch: { rule?: RoutingRule; timeoutMs?: number | null }) =>
    request<{ success: boolean }>(`/admin/api/priority-groups/${priority}`, {
      method: 'PUT',
      ...json(patch),
    }),

  settings: () => request<SettingsDTO>('/admin/api/settings'),

  saveSettings: (patch: SettingsPatch) =>
    request<SettingsDTO>('/admin/api/settings', { method: 'PUT', ...json(patch) }),

  dashboard: (range: { from?: string; to?: string } = {}) =>
    request<DashboardSummaryDTO>(`/admin/api/dashboard${toQuery(range)}`),

  requests: (query: RequestListQuery = {}) =>
    request<Paged<RequestSummaryDTO>>(`/admin/api/requests${toQuery(query as Record<string, unknown>)}`),

  requestDetail: (id: number) => request<RequestDetailDTO>(`/admin/api/requests/${id}`),

  ipStats: (ip: string, range: { from?: string; to?: string } = {}) =>
    request<IpDetailStatsDTO>(`/admin/api/ip-stats/${encodeURIComponent(ip)}${toQuery(range)}`),

  dailyUsage: (range: { from?: string; to?: string } = {}) =>
    request<UsageDailyDTO[]>(`/admin/api/usage${toQuery({ ...range, dimension: 'daily' })}`),

  providerUsage: (range: { from?: string; to?: string } = {}) =>
    request<ProviderUsageDTO[]>(`/admin/api/usage${toQuery({ ...range, dimension: 'provider' })}`),

  modelUsage: (range: { from?: string; to?: string } = {}) =>
    request<ModelUsageDTO[]>(`/admin/api/usage${toQuery({ ...range, dimension: 'model' })}`),

  ipUsage: (range: { from?: string; to?: string } = {}) =>
    request<IpUsageDTO[]>(`/admin/api/usage${toQuery({ ...range, dimension: 'ip' })}`),

  endpointHealth: () => request<EndpointHealthDTO>('/admin/api/endpoint-health'),

  providerModelHealth: (id: number) =>
    request<ChannelModelHealthDTO>(`/admin/api/providers/${id}/model-health`),

  setProviderModelEnabled: (id: number, model: string, enabled: boolean) =>
    request<{ success: boolean }>(
      `/admin/api/providers/${id}/models/${encodeURIComponent(model)}/enabled`,
      { method: 'PUT', ...json({ enabled }) },
    ),

  ipBlacklist: () => request<IpBlacklistDTO[]>('/admin/api/ip-blacklist'),

  addIpBlacklist: (ip: string, note: string | null) =>
    request<IpBlacklistDTO>(`/admin/api/ip-blacklist/${encodeURIComponent(ip)}`, {
      method: 'PUT',
      ...json({ note }),
    }),

  removeIpBlacklist: (ip: string) =>
    request<{ success: true }>(`/admin/api/ip-blacklist/${encodeURIComponent(ip)}`, { method: 'DELETE' }),

  runtime: () =>
    request<{
      config: { cached: boolean; loadedAt: string | null; providerCount: number; groupCount: number };
      writeQueue: { pending: number; enqueued: number; persisted: number; dropped: number; contentDropped: number; lastError: string | null };
      counters: {
        ipBuckets: number;
        rotationCursors: number;
        temporaryBlocks: number;
        temporaryThrottles: number;
      };
      upstreamClients: number;
      uptimeSec: number;
    }>('/admin/api/runtime'),

  sweepRetention: () =>
    request<{ deleted: number }>('/admin/api/retention/sweep', { method: 'POST' }),

  // ---- 内容审核

  moderationPolicies: () => request<ModerationPolicyDTO[]>('/admin/api/moderation/policies'),

  createModerationPolicy: (input: ModerationPolicyInput) =>
    request<ModerationPolicyDTO>('/admin/api/moderation/policies', { method: 'POST', ...json(input) }),

  updateModerationPolicy: (id: number, patch: Partial<ModerationPolicyInput>) =>
    request<ModerationPolicyDTO>(`/admin/api/moderation/policies/${id}`, { method: 'PUT', ...json(patch) }),

  deleteModerationPolicy: (id: number) =>
    request<{ success: boolean }>(`/admin/api/moderation/policies/${id}`, { method: 'DELETE' }),

  moderationDetectors: () =>
    request<ModerationDetectorInfoDTO[]>('/admin/api/moderation/detectors'),

  moderationCategories: () =>
    request<Array<{ category: ModerationCategory; label: string; parent: ModerationCategory | null; defaultSensitivity: number }>>(
      '/admin/api/moderation/categories',
    ),

  moderationBindings: () => request<ModerationBindingDTO[]>('/admin/api/moderation/bindings'),

  saveModerationBinding: (input: ModerationBindingInput) =>
    request<{ success: boolean }>('/admin/api/moderation/bindings', { method: 'PUT', ...json(input) }),

  deleteModerationBinding: (id: number) =>
    request<{ success: boolean }>(`/admin/api/moderation/bindings/${id}`, { method: 'DELETE' }),

  moderationEvents: (query: ModerationEventQuery & { blockedOnly?: boolean } = {}) =>
    request<Paged<ModerationEventDTO>>(
      `/admin/api/moderation/events${toQuery(query as Record<string, unknown>)}`,
    ),
};