/**
 * 服务端与前端共享的 DTO 定义。
 * web/ 通过 tsconfig path 别名直接引用本文件，保证前后端契约只有一份来源。
 */

export type RoutingRule = 'priority' | 'random' | 'average';

/** primary 参与常规路由；fallback / parallel 是单例特殊角色，DB 里同样是真实行 */
export type ProviderKind = 'primary' | 'fallback' | 'parallel';

/** 记录来源，取代旧实现里 isEnv / isContributed 两个布尔的组合语义 */
export type ProviderSource = 'managed' | 'env' | 'contributed';

export type AttemptStatus = 'success' | 'failed' | 'claimed-by-other';

export type AttemptRole = 'primary' | 'parallel' | 'fallback';

export interface ProviderDTO {
  id: number;
  name: string;
  displayName: string;
  baseUrl: string;
  /** apiKey 永不出站，只暴露是否已配置 */
  hasApiKey: boolean;
  models: string[];
  kind: ProviderKind;
  source: ProviderSource;
  priority: number;
  /** 由所属 priority_groups 派生，非本行字段 */
  effectiveRule: RoutingRule;
  enabled: boolean;
  contributor: string | null;
  contributorType: ContributorType | null;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderUpsertInput {
  name: string;
  baseUrl: string;
  /** 省略或空串表示保留原值 */
  apiKey?: string;
  models: string[];
  kind?: ProviderKind;
  priority?: number;
  enabled?: boolean;
}

export interface PriorityGroupDTO {
  priority: number;
  rule: RoutingRule;
  /** null 表示继承全局默认超时 */
  timeoutMs: number | null;
  providerCount: number;
}

export interface SettingsDTO {
  globalRule: RoutingRule;
  defaultResponseTimeoutMs: number;
  fallbackResponseTimeoutMs: number;
  parallelTimeoutMs: number;
  ipRateLimitRpm: number;
  maxPrimaryAttempts: number;
  maxModelRetryCount: number;
  /** 0 表示永不清理明细 */
  logRetentionDays: number;
}

export type SettingsPatch = Partial<SettingsDTO>;

export interface RequestListQuery {
  limit?: number;
  offset?: number;
  success?: boolean;
  requestedModel?: string;
  ip?: string;
  providerId?: number;
  from?: string;
  to?: string;
}

export interface RequestSummaryDTO {
  id: number;
  traceId: string;
  startedAt: string;
  completedAt: string | null;
  ttfbMs: number | null;
  totalMs: number | null;
  ip: string | null;
  requestedModel: string | null;
  finalModel: string | null;
  finalProviderName: string | null;
  finalRole: AttemptRole | null;
  stream: boolean;
  success: boolean;
  httpStatus: number | null;
  errorMessage: string | null;
  promptTokens: number;
  completionTokens: number;
  fallbackTriggered: boolean;
  attemptCount: number;
}

export interface RequestAttemptDTO {
  id: number;
  seq: number;
  role: AttemptRole;
  providerId: number | null;
  providerName: string | null;
  attemptedModel: string | null;
  actualModel: string | null;
  timeoutMs: number | null;
  status: AttemptStatus;
  errorMessage: string | null;
  startedAt: string;
  durationMs: number | null;
}

export interface RequestDetailDTO extends RequestSummaryDTO {
  errorCode: string | null;
  attempts: RequestAttemptDTO[];
}

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface DashboardSummaryDTO {
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  successRate: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  providers: ProviderUsageDTO[];
}

export interface ProviderUsageDTO {
  providerId: number | null;
  name: string;
  kind: ProviderKind;
  enabled: boolean;
  requests: number;
  success: number;
  failed: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelUsageDTO {
  requestedModel: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  /** 请求模型 -> 上游真实模型的分布 */
  actualResolved: Array<{ model: string; requests: number }>;
}

export interface IpUsageDTO {
  ip: string;
  requests: number;
  tokens: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

export interface PublicStatsDTO {
  totalRequests: number;
  totalTokens: number;
  successRate: number;
}

export type ContributorType = 'email' | 'github';

export interface ContributionListItemDTO {
  id: number;
  name: string;
  contributor: string;
  contributorType: ContributorType;
  displayName: string;
  avatarUrl: string | null;
  /** 只保留 origin + pathname */
  baseUrl: string;
  modelCount: number;
  models: string[];
  enabled: boolean;
  updatedAt: string;
}

export interface ContributionSubmitInput {
  contributor: string;
  baseUrl: string;
  apiKey: string;
  models: string | string[];
}

export interface ContributionModelResult {
  model: string;
  ok: boolean;
  reply?: string;
  error?: string;
}

export interface ContributionSubmitResult {
  success: boolean;
  action: 'created' | 'updated';
  provider: Pick<
    ContributionListItemDTO,
    'id' | 'name' | 'contributor' | 'contributorType' | 'displayName' | 'avatarUrl' | 'enabled' | 'modelCount'
  >;
  results: ContributionModelResult[];
}

export interface AuthStateDTO {
  authenticated: boolean;
  needAuth: boolean;
}

export interface ApiErrorBody {
  error: {
    message: string;
    code?: string;
  };
}