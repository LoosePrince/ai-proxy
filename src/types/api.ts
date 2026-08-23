/**
 * 服务端与前端共享的 DTO 定义。
 * web/ 通过 tsconfig path 别名直接引用本文件，保证前后端契约只有一份来源。
 */

export type RoutingRule = 'priority' | 'random' | 'average';

export type RequestBehaviorAction = 'ignore' | 'error' | 'strip-system-prompt' | 'only-user-messages';

export type MaliciousBehaviorAction = 'ignore' | 'error' | 'response';

/** primary 参与常规路由；fallback / parallel 是单例特殊角色，DB 里同样是真实行 */
export type ProviderKind = 'primary' | 'fallback' | 'parallel';

/** 记录来源，取代旧实现里 isEnv / isContributed 两个布尔的组合语义 */
export type ProviderSource = 'managed' | 'env' | 'contributed';

/** Provider 的请求执行方式。script 模式由后台信任的 Node.js 源码完全接管请求。 */
export type ProviderRequestMode = 'openai' | 'script';

export type ProviderScriptScheduleStatus = 'idle' | 'running' | 'success' | 'failed';
export type ProviderVariableType = 'text' | 'password' | 'number' | 'switch';


export interface ProviderScriptRuntimeDTO {
  mainScript: string;
  scheduleEnabled: boolean;
  scheduleCron: string;
  scheduleStatus: ProviderScriptScheduleStatus;
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  lastRunError: string | null;
  variablesUpdatedAt: string | null;
}

export interface ProviderVariableDefinition {
  name: string;
  label: string;
  type: ProviderVariableType;
  defaultValue: string | number | boolean;
  required?: boolean;
  /** 密码变量仅用于管理界面显示是否已配置，不携带明文。 */
  secretConfigured?: boolean;
}

export type AttemptStatus = 'success' | 'failed' | 'claimed-by-other';

export type AttemptRole = 'primary' | 'parallel' | 'fallback';

/**
 * 请求结局分类。
 *
 * 取代原先单一的 `success` 布尔：布尔只能表达「成/败」，无法区分
 * 「上游真的失败了」与「客户端自己挂断了」「结果来自缓存复用」，
 * 而这三者对可用性的含义完全不同，混在一起会同时污染两个方向：
 *   - 缓存命中会虚高 provider 的成功率与请求数（该 provider 本次没被调用）
 *   - 客户端取消会被记成上游故障，把用户行为算成服务质量问题
 *
 *   upstream_ok     真实调用上游并成功返回
 *   cache_hit       命中持久化缓存，未触达上游
 *   upstream_error  上游失败 / 超时 / 无可用 provider
 *   client_abort    客户端在响应完成前断开
 *   rejected        网关自己拒绝（如限流），未触达上游
 */
export type RequestOutcome =
  | 'upstream_ok'
  | 'cache_hit'
  | 'upstream_error'
  | 'client_abort'
  | 'rejected';

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
  /** Provider 级内置系统提示词，不包含 apiKey 等敏感信息 */
  systemPrompt: string;
  requestMode: ProviderRequestMode;
  requestScript: string;
  variables: ProviderVariableDefinition[];
  variablesAutoSync: boolean;
  mainScript: string;
  scheduleEnabled: boolean;
  scheduleCron: string;
  scheduleStatus: ProviderScriptScheduleStatus;
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  lastRunError: string | null;
  variablesUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderUpsertInput {
  name: string;
  baseUrl: string;
  /** 省略或空串表示保留原值 */
  apiKey?: string;
  models: string[];
  /** Provider 级内置系统提示词 */
  systemPrompt?: string;
  requestMode?: ProviderRequestMode;
  requestScript?: string;
  variables?: ProviderVariableDefinition[];
  variablesAutoSync?: boolean;
  mainScript?: string;
  scheduleEnabled?: boolean;
  scheduleCron?: string;
  kind?: ProviderKind;
  priority?: number;
  enabled?: boolean;
}

export interface ProviderTestInput {
  model?: string;
  payload?: Record<string, unknown>;
  variables?: Record<string, string | number | boolean>;
}

export interface ProviderTestResult {
  ok: boolean;
  status: number;
  elapsedMs: number;
  actualModel: string | null;
  response: unknown;
  error?: string;
}

export interface PriorityGroupDTO {
  priority: number;
  rule: RoutingRule;
  /** null 表示继承全局默认超时 */
  timeoutMs: number | null;
  providerCount: number;
}

export interface PublicSiteConfigDTO {
  adminEntryEnabled: boolean;
  projectUrl: string;
}

export interface SettingsDTO {
  /** 是否在公开首页显示管理后台入口 */
  adminEntryEnabled: boolean;
  /** 项目主页地址，同时用于指南页和页脚 */
  projectUrl: string;
  globalRule: RoutingRule;
  defaultResponseTimeoutMs: number;
  fallbackResponseTimeoutMs: number;
  parallelTimeoutMs: number;
  ipRateLimitRpm: number;
  maxPrimaryAttempts: number;
  maxModelRetryCount: number;
  /** 0 表示永不清理明细 */
  logRetentionDays: number;
  /** 保存客户端请求、实际上游请求与响应正文到请求日志 */
  requestContentLoggingEnabled: boolean;
  /** 开放仅包含脱敏快照的实时 SSE 端点 */
  publicRequestContentStreamEnabled: boolean;
  /** 开放 /api/public-stats/detailed 与首页的详细状态页入口 */
  publicDetailedStatsEnabled: boolean;
  /** 允许相同协议与传输形态的请求复用持久化响应 */
  requestCacheEnabled: boolean;
  /** 只命中此时间窗口内写入的缓存，后台会自动删除超过窗口的缓存行 */
  requestCacheReuseHours: number;
  /** 所有 Provider 共享的内置强制系统提示词 */
  globalSystemPrompt: string;
  /** 是否将全局系统提示词注入上游请求 */
  globalSystemPromptEnabled: boolean;
  /** 是否启用 IDE 环境或工具链请求处理 */
  ideRequestHandlingEnabled: boolean;
  /** 是否启用恶意内容请求处理 */
  maliciousRequestHandlingEnabled: boolean;
  /** 检测到 IDE 环境或工具链请求后的处理方式 */
  ideRequestAction: RequestBehaviorAction;
  /** 检测到恶意内容后的处理方式 */
  maliciousRequestAction: MaliciousBehaviorAction;
  /** maliciousRequestAction=response 时返回的文本 */
  maliciousResponse: string;
}

export type SettingsPatch = Partial<SettingsDTO>;

export interface RequestListQuery {
  limit?: number;
  offset?: number;
  success?: boolean;
  outcome?: RequestOutcome;
  requestedModel?: string;
  ip?: string;
  providerId?: number;
  from?: string;
  to?: string;
}

/**
 * 一组结局计数。所有成功率都由它派生，避免各处各算一套口径。
 *
 * requests = upstreamOk + cacheHit + upstreamError + clientAbort + rejected
 */
export interface OutcomeBreakdown {
  requests: number;
  upstreamOk: number;
  cacheHit: number;
  upstreamError: number;
  clientAbort: number;
  rejected: number;
}

/**
 * 两个口径刻意分开，因为它们回答的是不同的问题：
 *
 *   serviceSuccessRate  = (upstreamOk + cacheHit) / (requests - clientAbort)
 *                         「用户发起的请求里，有多少真的拿到了结果」
 *                         缓存复用是有效交付，计入；客户端自己挂断不是服务的锅，剔除。
 *
 *   upstreamSuccessRate = upstreamOk / (upstreamOk + upstreamError)
 *                         「真正打到上游的调用里，上游有多少次成功」
 *                         缓存命中没有触达上游，必须排除，否则会虚高。
 */
export interface SuccessRates {
  serviceSuccessRate: number;
  upstreamSuccessRate: number;
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
  cacheHit: boolean;
  success: boolean;
  outcome: RequestOutcome;
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

export interface RequestContentDTO {
  clientRequest: unknown;
  upstreamRequest: unknown;
  aiResponse: unknown;
}

export interface RequestDetailDTO extends RequestSummaryDTO {
  errorCode: string | null;
  attempts: RequestAttemptDTO[];
  content: RequestContentDTO | null;
}

export interface PublicRequestContentEventDTO {
  id: string;
  occurredAt: string;
  protocol: 'chat' | 'responses';
  stream: boolean;
  model: string | null;
  request: unknown;
  response: unknown;
}

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface UsageDailyDTO extends OutcomeBreakdown, SuccessRates {
  day: string;
  /** 旧系统累计统计导入的占位日，不代表真实发生日期。 */
  isHistorical: boolean;
  /** = upstreamOk + cacheHit，即成功交付给客户端的请求数 */
  success: number;
  /** = upstreamError + rejected，不含 clientAbort */
  failed: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface DashboardSummaryDTO extends OutcomeBreakdown, SuccessRates {
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  providers: ProviderUsageDTO[];
}

export interface ProviderUsageDTO extends OutcomeBreakdown, SuccessRates {
  providerId: number | null;
  name: string;
  kind: ProviderKind;
  enabled: boolean;
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

export interface IpBlacklistDTO {
  ip: string;
  note: string | null;
  createdAt: string;
}

export interface IpUsageDTO {
  ip: string;
  requests: number;
  tokens: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

/**
 * 首页公开统计。
 *
 * successRate 采用 serviceSuccessRate 口径：缓存复用算成功，客户端取消不计入分母。
 * detailedStatsEnabled 决定首页是否展示「详细状态页」入口，由后台开关控制。
 */
export interface PublicStatsDTO {
  totalRequests: number;
  totalTokens: number;
  successRate: number;
  detailedStatsEnabled: boolean;
}

/** 公开详细状态页数据。只包含可对外披露的聚合口径，不含 IP、Provider 名称与请求正文。 */
export interface PublicDetailedStatsDTO {
  overall: OutcomeBreakdown & SuccessRates;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  /** 参与路由的 Provider 数量，只给规模感，不披露具体身份 */
  activeProviders: number;
  daily: PublicDailyStatsDTO[];
  /** 真实模型分布（按实际路由到的 actual_model 聚合），按请求量降序 */
  models: PublicModelStatsDTO[];
  generatedAt: string;
}

export interface PublicDailyStatsDTO extends SuccessRates {
  day: string;
  /** 旧系统累计统计导入的占位日，不代表真实发生日期。 */
  isHistorical: boolean;
  requests: number;
  success: number;
  failed: number;
  cacheHit: number;
  clientAbort: number;
  totalTokens: number;
}

export interface PublicModelStatsDTO {
  model: string;
  requests: number;
  totalTokens: number;
}

export type ContributorType = 'email' | 'github';

export interface ContributionListItemDTO {
  id: number;
  name: string;
  /** 邮箱类型仅返回星号脱敏后的本地 ID，不包含邮箱后缀 */
  contributor: string;
  contributorType: ContributorType;
  /** 与公开 contributor 使用相同脱敏规则 */
  displayName: string;
  /** QQ 与 GitHub 使用公开头像，其他邮箱为 null。 */
  avatarUrl: string | null;
  modelCount: number;
  /** 已验证且会被记录的模型 */
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