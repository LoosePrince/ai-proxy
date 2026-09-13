/**
 * 服务端与前端共享的 DTO 定义。
 * web/ 通过 tsconfig path 别名直接引用本文件，保证前后端契约只有一份来源。
 */

export type RoutingRule = 'priority' | 'random' | 'average';

export type RequestBehaviorAction = 'ignore' | 'error' | 'strip-system-prompt' | 'only-user-messages';

/**
 * 违禁内容触发后的处理方式。
 *   ban       永久封禁该 IP（写入黑名单），并拒绝本次请求
 *   block     临时拦截该 IP（内存级，持续 maliciousThrottleMinutes 分钟），拒绝本次请求
 *   throttle  临时限流该 IP（内存级，持续 maliciousThrottleMinutes 分钟），拒绝本次请求
 *   empty     空回复（200 + 空消息）
 *   error     报错（返回错误码）
 *   response  返回指定响应内容
 */
export type MaliciousBehaviorAction = 'ban' | 'block' | 'throttle' | 'empty' | 'error' | 'response';

/**
 * 内容审核类别（识别方向）。
 *
 * 采用 OpenAI moderation 风格的层级命名：子类别以 `父/子` 表示，
 * 例如 `violence/graphic` 属于 `violence`。父类别启用即覆盖其全部子类别，
 * 子类别可单独关闭或调高敏感度。
 */
export type ModerationCategory =
  | 'sexual'
  | 'sexual/minors'
  | 'harassment'
  | 'harassment/threatening'
  | 'hate'
  | 'hate/threatening'
  | 'self-harm'
  | 'self-harm/intent'
  | 'self-harm/instructions'
  | 'violence'
  | 'violence/graphic'
  | 'illicit'
  | 'illicit/violent'
  | 'profanity';

/**
 * 多个检测引擎之间的组合模式。
 *   strict    任一启用引擎命中即拦截（每个引擎都必须放行，默认，等价「通过所有库的检测」）
 *   majority  超过半数启用引擎命中才拦截
 *   lenient   全部启用引擎都命中才拦截
 */
export type ModerationCombineMode = 'strict' | 'majority' | 'lenient';

/** 审核阶段：请求侧（用户输入）或响应侧（模型输出） */
export type ModerationStage = 'input' | 'output';

/** 作用域层级：全局默认策略被 Provider / 模型级绑定覆盖 */
export type ModerationScopeType = 'provider' | 'model';

/** 输出侧命中后的处理方式，HTTP 状态码已可能写出，因此不含 IP 级动作 */
export type ModerationOutputAction = 'empty' | 'error' | 'response';

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

export type AnnouncementLevel = 'info' | 'warning' | 'success';

export interface AnnouncementDTO {
  id: number;
  title: string;
  body: string;
  level: AnnouncementLevel;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AnnouncementInput {
  title: string;
  body: string;
  level: AnnouncementLevel;
  enabled: boolean;
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
  /** 该 Provider（及其全部模型）不参与模型 id 匹配，只能被正常路由命中 */
  excludeFromModelMatching: boolean;
  /** 仅这些模型名不参与模型 id 匹配，其余模型仍可被匹配 */
  modelMatchExcludeModels: string[];
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
  /** 不参与模型 id 匹配（该 Provider 及全部模型只能被正常路由命中） */
  excludeFromModelMatching?: boolean;
  /** 仅这些模型名不参与模型 id 匹配 */
  modelMatchExcludeModels?: string[];
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
  /** 自定义违禁提示词内容，每行或逗号分隔一个词 */
  forbiddenKeywords: string;
  /** block / throttle 处理方式下拦截或限流的时长（分钟） */
  maliciousThrottleMinutes: number;
  /** 拦截 / 封禁请求时返回给客户端的报错消息 */
  blockedErrorMessage: string;
  /** 是否启用模型名相近匹配（例如用模型 ID 优先匹配到声明了近似模型名的 Provider） */
  fuzzyModelMatchingEnabled: boolean;
  /** 是否启用多层内容审核系统（与旧版恶意内容检测并存，默认关闭） */
  moderationEnabled: boolean;
  /** 审核请求侧内容（用户输入） */
  moderationInputEnabled: boolean;
  /** 审核响应侧内容（模型输出） */
  moderationOutputEnabled: boolean;
  /** 流式响应是否逐块审核；关闭时流式响应跳过输出审核，仅审非流式 */
  moderationOutputStreamEnabled: boolean;
  /** 审核事件审计日志保留天数，0 表示永不清理 */
  moderationAuditRetentionDays: number;
  /** 同 IP 每 10 分钟请求数上限，0 表示不启用 */
  ipRateLimitPer10Min: number;
  /** 同 IP 每 30 分钟请求数上限，0 表示不启用 */
  ipRateLimitPer30Min: number;
  /** 自定义限流窗口长度（小时），0 表示不启用 */
  ipRateLimitHours: number;
  /** 同 IP 在自定义窗口（ipRateLimitHours 小时）内的请求数上限，0 表示不启用 */
  ipRateLimitPerXHours: number;
}

export type SettingsPatch = Partial<SettingsDTO>;

export interface RequestListQuery {
  limit?: number;
  offset?: number;
  success?: boolean;
  /** 多选结局筛选，空/缺省 = 不过滤 */
  outcomes?: RequestOutcome[];
  requestedModel?: string;
  ip?: string;
  /** 多选 Provider 筛选，空/缺省 = 不过滤 */
  providerIds?: number[];
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
 *   serviceSuccessRate  = (upstreamOk + cacheHit) / (requests - clientAbort - rejected)
 *                         「用户发起的请求里，有多少真的拿到了结果」
 *                         缓存复用是有效交付，计入；客户端自己挂断不是服务的锅，剔除；
 *                         被网关拦截 / 封禁的请求是策略决定而非服务故障，也剔除，
 *                         否则会虚拉低交付率。
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

/**
 * 端点健康状态。由后端根据窗口内的真实上游尝试判定，前端只负责上色，
 * 保证「正常 / 降级 / 异常」在各处只有一个判定源。
 *
 *   ok       可用率 ≥ 95%
 *   degraded 可用率 ≥ 80%
 *   down     可用率 < 80%
 *   idle     窗口内没有打到上游的尝试（无流量，不代表故障）
 */
export type EndpointHealthState = 'ok' | 'degraded' | 'down' | 'idle';

/** 逐日健康样本，供状态页的色条渲染；窗口内没有样本的日期由后端补 idle 占位 */
export interface EndpointHealthSampleDTO {
  day: string;
  attempts: number;
  success: number;
  failed: number;
  state: EndpointHealthState;
  /** 当日可用率（%）；当日无样本时为 null */
  availability: number | null;
}

/** 渠道（Provider）维度的健康视图，对应后台状态监控页的渠道行 */
export interface ChannelHealthDTO {
  /** 0 表示尝试没有 provider 归属 */
  providerId: number;
  name: string;
  /** provider 行已被删除时为 null，历史数据仍保留 */
  kind: ProviderKind | null;
  enabled: boolean;
  state: EndpointHealthState;
  /** 最近有流量的那天的平均对话耗时（成功尝试的 duration_ms） */
  latestLatencyMs: number | null;
  /** 窗口内成功请求首字节的最小值，作为端点连通延迟的近似 */
  pingMs: number | null;
  availability7d: number | null;
  availability30d: number | null;
  avgLatency7d: number | null;
  attempts7d: number;
  success7d: number;
  failed7d: number;
  /** 并行竞速落败的次数，不计入可用率分母 */
  claimed7d: number;
  attempts30d: number;
  lastSeenAt: string | null;
  samples: EndpointHealthSampleDTO[];
}

/** 模型维度的健康视图，对应后台状态监控页的模型表 */
export interface ModelHealthDTO {
  model: string;
  state: EndpointHealthState;
  latestLatencyMs: number | null;
  availability7d: number | null;
  availability15d: number | null;
  availability30d: number | null;
  avgLatency7d: number | null;
  attempts7d: number;
  attempts30d: number;
  lastSeenAt: string | null;
  samples: EndpointHealthSampleDTO[];
}

export interface EndpointHealthDTO {
  /** 统计窗口天数，样本数组就是这个长度 */
  windowDays: number;
  channels: ChannelHealthDTO[];
  models: ModelHealthDTO[];
  generatedAt: string;
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
 * 单个 IP 的详细统计（日志页右键「查看统计信息」）。
 *
 * 从 requests 明细表按 IP 聚合，口径与全局统计一致：
 *   - successRates 由 successRatesOf 派生（缓存复用算成功、客户端取消剔除分母）
 *   - 模型分布按 requested_model 分组，超过 modelLimit 时合并为「其他」由前端展示
 */
export interface IpDetailStatsDTO {
  ip: string;
  requests: number;
  totalTokens: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  avgTtfbMs: number | null;
  avgTotalMs: number | null;
  breakdown: OutcomeBreakdown;
  serviceSuccessRate: number;
  upstreamSuccessRate: number;
  models: Array<{ model: string; requests: number }>;
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

// ------------------------------------------------------------------ 内容审核

/** 单个类别的策略配置 */
export interface ModerationCategorySettingDTO {
  category: ModerationCategory;
  enabled: boolean;
  /** 敏感度 0-100：越高越严格。阈值 = 1 - 敏感度/100，命中分 >= 阈值即判定命中。 */
  sensitivity: number;
}

/** 单个检测引擎在策略中的配置 */
export interface ModerationDetectorSettingDTO {
  detectorId: string;
  enabled: boolean;
  /** 非原生分类引擎（visulima / obscenity）的通用命中归属到这些类别 */
  categories: ModerationCategory[];
}

export interface ModerationPolicyDTO {
  id: number;
  name: string;
  description: string;
  enabled: boolean;
  /** 全局默认策略；同一时间只允许一条 */
  isDefault: boolean;
  combineMode: ModerationCombineMode;
  /** 请求侧命中动作，复用旧版恶意内容动作（含 IP 级 ban/block/throttle） */
  action: MaliciousBehaviorAction;
  /** 响应侧命中动作 */
  outputAction: ModerationOutputAction;
  /** outputAction=response 时替换的文本 */
  outputResponse: string;
  /** 流式输出审核的滞后窗口（字符），越大越能拦住跨块拆词，代价是首字延迟 */
  holdBackChars: number;
  /** 请求侧命中可返回的文本（action=response） */
  response: string;
  /** 自定义违禁词，每行或逗号分隔一个；作为 builtin-lexicon 的扩展词条 */
  forbiddenKeywords: string;
  categories: ModerationCategorySettingDTO[];
  detectors: ModerationDetectorSettingDTO[];
  createdAt: string;
  updatedAt: string;
}

export interface ModerationPolicyInput {
  name: string;
  description?: string;
  enabled?: boolean;
  isDefault?: boolean;
  combineMode?: ModerationCombineMode;
  action?: MaliciousBehaviorAction;
  outputAction?: ModerationOutputAction;
  outputResponse?: string;
  holdBackChars?: number;
  response?: string;
  forbiddenKeywords?: string;
  categories?: ModerationCategorySettingDTO[];
  detectors?: ModerationDetectorSettingDTO[];
}

export interface ModerationBindingDTO {
  id: number;
  scopeType: ModerationScopeType;
  /** scopeType=provider 时生效 */
  providerId: number | null;
  providerName: string | null;
  /** scopeType=model 时生效 */
  model: string | null;
  policyId: number;
  policyName: string | null;
  createdAt: string;
}

export interface ModerationBindingInput {
  scopeType: ModerationScopeType;
  providerId?: number | null;
  model?: string | null;
  policyId: number;
}

/** 引擎能力描述，供后台展示可用性并决定可选类别 */
export interface ModerationDetectorInfoDTO {
  id: string;
  label: string;
  description: string;
  /** 依赖是否已安装且可加载 */
  available: boolean;
  /** 是否自行输出类别（否则命中归属由策略配置决定） */
  nativeCategories: boolean;
  /** 引擎可识别的类别；'all' 表示可承担策略里配置的任意类别 */
  categories: ModerationCategory[] | 'all';
  languages: string[];
  /** 可选依赖包名；内置引擎为 null */
  dependency: string | null;
  /** 不可用时的原因（已翻译为可读说明），可用时为 null */
  reason: string | null;
  /** 不可用时的修复建议（可直接执行的命令或版本要求） */
  hint: string | null;
}

export interface ModerationEventDTO {
  id: number;
  traceId: string;
  occurredAt: string;
  stage: ModerationStage;
  /** 命中的类别，逗号分隔的类别 id 列表 */
  categories: ModerationCategory[];
  detectorIds: string[];
  score: number | null;
  /** 已脱敏的命中片段 */
  matched: string[];
  action: string;
  blocked: boolean;
  ip: string | null;
  policyId: number | null;
  policyName: string | null;
  providerName: string | null;
  model: string | null;
}

export interface ModerationEventQuery {
  limit?: number;
  offset?: number;
  stage?: ModerationStage;
  category?: ModerationCategory;
  blockedOnly?: boolean;
  from?: string;
  to?: string;
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