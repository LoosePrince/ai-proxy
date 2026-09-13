/**
 * 后台路由 /admin/api/*。
 *
 * 相对旧实现的结构性变化：
 *   - providers 列表不再靠 `priority >= 0` 过滤虚拟行，改按 kind 区分角色
 *   - global-route（负 priority 虚拟行 + stats.modelConfig JSON）拆成
 *     真实的 settings 表 与 priority_groups 表两个独立资源
 *   - apiKey 一律不出站：只返回 hasApiKey，输入侧「留空即保持不变」，
 *     不再用「字符串是否含 ***」这种会误伤真实 key 的启发式判断
 *   - 日志从内存 200 条上限变为对 requests 表的服务端分页查询
 *
 * 所有写操作后必须 invalidateConfig()，否则热路径继续读旧快照。
 */

import { isIP } from 'node:net';

import express, { type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';

import {
  createProvider,
  deleteProvider,
  findProviderById,
  listPriorityGroups,
  listProviders,
  pruneEmptyPriorityGroups,
  savePriorityGroup,
  setProviderModelEnabled,
  updateProvider,
  type ProviderRecord,
} from '../db/repo/providers';
import { addIpBlacklist, listIpBlacklist, removeIpBlacklist } from '../db/repo/ip-blacklist';
import {
  createAnnouncement,
  deleteAnnouncement,
  findAnnouncementById,
  listAnnouncements,
  updateAnnouncement,
} from '../db/repo/announcements';
import {
  createModerationPolicy,
  defaultDetectorSettings,
  deleteModerationBinding,
  deleteModerationPolicy,
  findModerationPolicyById,
  listModerationBindings,
  listModerationPolicies,
  queryModerationEvents,
  updateModerationPolicy,
  upsertModerationBinding,
} from '../db/repo/moderation';
import { getRequestDetail, getIpDetailStats, queryRequests } from '../db/repo/requests';
import { listDetectorInfo, detectorById } from '../core/moderation/detectors';
import { MODERATION_CATEGORIES, categoryMeta } from '../core/moderation/taxonomy';
import { LsqliteError } from '../db/lsqlite';
import {
  loadSettings,
  normalizeModelHealthRoutingMode,
  normalizeRoutingRule,
  saveSettings,
} from '../db/repo/settings';
import {
  getDailyUsage,
  getDashboardSummary,
  getIpUsage,
  getModelUsage,
  getProviderUsage,
} from '../db/repo/usage';
import { getChannelModelHealth, getEndpointHealth } from '../db/repo/endpoint-health';
import { prependBuiltInSystemPrompt } from '../core/system-prompt';
import { getConfig, invalidateConfig, peekConfig } from '../runtime/config-cache';
import { resolveTimeoutMs } from '../core/timeout';
import { type JsonRecord } from '../core/protocol';
import { counterStats } from '../runtime/counters';
import { getWriteQueueStats } from '../runtime/write-queue';
import { runRetentionSweep } from '../runtime/retention';
import { startProviderScriptScheduler, runProviderMain, refreshProviderScriptSchedules } from '../runtime/provider-scripts';
import { validateCron } from '../runtime/cron';
import { executeProviderScript } from '../upstream/script';
import { getUpstreamClient, upstreamClientCount } from '../upstream/client';
import { withTimeout } from '../core/timeout';
import type {
  AnnouncementDTO,
  AnnouncementInput,
  AnnouncementLevel,
  PriorityGroupDTO,
  ProviderKind,
  RequestBehaviorAction,
  MaliciousBehaviorAction,
  RequestListQuery,
  RequestOutcome,
  RoutingRule,
  SettingsPatch,
  ProviderRequestMode,
  ProviderVariableDefinition,
  ModerationCategory,
  ModerationCategorySettingDTO,
  ModerationCombineMode,
  ModerationDetectorSettingDTO,
  ModerationEventQuery,
  ModerationOutputAction,
  ModerationPolicyInput,
  ModerationScopeType,
} from '../types/api';
import { toProviderDTO } from './dto';

const router = express.Router();

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
/** 未配置账号密码时后台开放访问，与旧行为一致 */
const NEED_AUTH = !!(ADMIN_USERNAME && ADMIN_PASSWORD);

if (!NEED_AUTH) {
  console.warn('[Admin] ADMIN_USERNAME/ADMIN_PASSWORD not set — admin console is publicly accessible');
}

router.use(
  session({
    secret: process.env.SESSION_SECRET || 'ai-proxy-admin-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 3_600_000, httpOnly: true, sameSite: 'lax' },
  }),
);

declare module 'express-session' {
  interface SessionData {
    authenticated?: boolean;
  }
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!NEED_AUTH || req.session?.authenticated) {
    next();
    return;
  }
  res.status(401).json({ error: { message: 'Authentication required' } });
}

// ------------------------------------------------------------------ 输入校验

class BadRequest extends Error {}

function fail(res: Response, error: unknown): void {
  if (error instanceof BadRequest) {
    res.status(400).json({ error: { message: error.message } });
    return;
  }

  const message = (error as Error)?.message ?? 'Internal error';
  // 唯一索引冲突：provider 重名
  if (/unique/i.test(message)) {
    res.status(409).json({ error: { message: 'Provider 名称已存在' } });
    return;
  }

  /*
   * 远程库故障不是调用方的输入错误。一律回 500 会让「连接失败 / 413 / 鉴权被拒」
   * 看起来像代码 bug，排查时只能去翻容器日志；这里显式区分并带上前缀，
   * 状态码也保留下来（超时与连接重置没有状态码）。
   */
  if (error instanceof LsqliteError) {
    console.error(`[Admin] database error: ${message}${statusSuffix(error)}`);
    res.status(502).json({ error: { message: `数据库不可用：${message}${statusSuffix(error)}` } });
    return;
  }

  console.error(`[Admin] ${message}`);
  res.status(500).json({ error: { message } });
}

function statusSuffix(error: LsqliteError): string {
  return error.status ? ` (HTTP ${error.status})` : '';
}

function errorStatus(error: unknown): number {
  if (error instanceof BadRequest) return 400;
  const candidate = error as { status?: number; response?: { status?: number } };
  return candidate?.status ?? candidate?.response?.status ?? 500;
}

function errorMessage(error: unknown): string {
  return (error as Error)?.message ?? '请求测试失败';
}

function requireString(value: unknown, label: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new BadRequest(`${label} 不能为空`);
  return text;
}

function requireHttpUrl(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (!/^https?:\/\//i.test(text)) throw new BadRequest(`${label} 必须以 http:// 或 https:// 开头`);
  return text;
}

function toModels(value: unknown): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[,\n]/);
  return [...new Set(list.map((item) => String(item ?? '').trim()).filter(Boolean))];
}

function toRequestMode(value: unknown): ProviderRequestMode {
  if (value === undefined || value === 'openai') return 'openai';
  if (value === 'script') return 'script';
  throw new BadRequest('requestMode 只允许 openai / script');
}

function toVariables(value: unknown): ProviderVariableDefinition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new BadRequest('variables 必须是数组');

  const names = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new BadRequest(`第 ${index + 1} 个变量无效`);
    const item = raw as Record<string, unknown>;
    const name = requireString(item.name, `第 ${index + 1} 个变量名`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new BadRequest(`变量 ${name} 只能使用字母、数字和下划线，且不能以数字开头`);
    }
    if (names.has(name)) throw new BadRequest(`变量 ${name} 重复`);
    names.add(name);
    const type = item.type;
    if (!['text', 'password', 'number', 'switch'].includes(String(type))) {
      throw new BadRequest(`变量 ${name} 类型无效`);
    }
    const defaultValue = item.defaultValue;
    if (
      typeof defaultValue !== 'string' &&
      typeof defaultValue !== 'number' &&
      typeof defaultValue !== 'boolean'
    ) {
      throw new BadRequest(`变量 ${name} 的默认值无效`);
    }
    return {
      name,
      label: requireString(item.label ?? name, `变量 ${name} 标签`),
      type: type as ProviderVariableDefinition['type'],
      defaultValue,
      required: !!item.required,
    };
  });
}

function mergeSecretVariables(
  existing: ProviderVariableDefinition[],
  incoming: ProviderVariableDefinition[],
): ProviderVariableDefinition[] {
  const existingByName = new Map(existing.map((variable) => [variable.name, variable]));
  return incoming.map((variable) => {
    const previous = existingByName.get(variable.name);
    if (variable.type === 'password' && variable.defaultValue === '' && previous?.type === 'password' && previous.defaultValue !== '') {
      return { ...variable, defaultValue: previous.defaultValue };
    }
    return variable;
  });
}

function toScheduleCron(value: unknown, enabled: boolean): string {
  const cron = String(value ?? '').trim();
  if (enabled && !cron) throw new BadRequest('启用 cron 时必须填写表达式');
  if (cron) {
    try {
      return validateCron(cron);
    } catch (error) {
      throw new BadRequest((error as Error).message);
    }
  }
  return '';
}

function toKind(value: unknown): ProviderKind {
  if (value === 'fallback' || value === 'parallel') return value;
  if (value === undefined || value === 'primary') return 'primary';
  throw new BadRequest('kind 只允许 primary / fallback / parallel');
}

function toPriority(value: unknown): number {
  const num = Number(value ?? 0);
  if (!Number.isInteger(num) || num < 0) throw new BadRequest('priority 必须是大于等于 0 的整数');
  return num;
}

function toPositiveInt(value: unknown, label: string): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) throw new BadRequest(`${label} 必须是大于 0 的毫秒数`);
  return Math.round(num);
}

function toNonNegativeInt(value: unknown, label: string): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) throw new BadRequest(`${label} 必须是大于等于 0 的整数`);
  return Math.round(num);
}

function toIdeAction(value: unknown): RequestBehaviorAction {
  if (value === 'ignore' || value === 'error' || value === 'strip-system-prompt' || value === 'only-user-messages') {
    return value;
  }
  throw new BadRequest('IDE 请求处理方式无效');
}

function toMaliciousAction(value: unknown): MaliciousBehaviorAction {
  if (value === 'ignore') return 'empty';
  if (
    value === 'ban' ||
    value === 'block' ||
    value === 'throttle' ||
    value === 'empty' ||
    value === 'error' ||
    value === 'response'
  ) {
    return value;
  }
  throw new BadRequest('恶意请求处理方式无效');
}

function normalizeIp(value: string): string {
  return value.replace(/^::ffff:/i, '');
}

function toIp(value: unknown): string {
  const ip = normalizeIp(requireString(value, 'IP'));
  if (!isIP(ip)) throw new BadRequest('IP 必须是有效的 IPv4 或 IPv6 地址');
  return ip;
}

function toOptionalNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const note = String(value).trim();
  if (note.length > 200) throw new BadRequest('备注不能超过 200 个字符');
  return note || null;
}

// ------------------------------------------------------------------ 登录态

router.post('/api/login', (req: Request, res: Response) => {
  if (!NEED_AUTH) {
    res.json({ success: true });
    return;
  }

  const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    res.json({ success: true });
    return;
  }

  res.status(401).json({ error: { message: '用户名或密码错误' } });
});

router.post('/api/logout', (req: Request, res: Response) => {
  req.session.destroy(() => res.json({ success: true }));
});

router.get('/api/auth-check', (req: Request, res: Response) => {
  res.json({
    authenticated: NEED_AUTH ? !!req.session?.authenticated : true,
    needAuth: NEED_AUTH,
  });
});

// ------------------------------------------------------------------ Provider

/** 组规则由 priority_groups 决定，DTO 里的 effectiveRule 由此派生 */
async function ruleResolver(): Promise<(record: ProviderRecord) => RoutingRule> {
  const config = await getConfig();
  return (record) => config.groups.get(record.priority)?.rule ?? 'priority';
}

router.get('/api/providers', requireAuth, async (_req: Request, res: Response) => {
  try {
    const [records, ruleOf] = await Promise.all([listProviders(), ruleResolver()]);
    res.json(records.map((record) => toProviderDTO(record, ruleOf(record))));
  } catch (error) {
    fail(res, error);
  }
});

router.post('/api/providers', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kind = toKind(body.kind);
    const requestMode = toRequestMode(body.requestMode);

    const scheduleEnabled = !!body.scheduleEnabled;
    const mainScript = body.mainScript === undefined ? '' : String(body.mainScript);
    const scheduleCron = toScheduleCron(body.scheduleCron, scheduleEnabled);
    if (scheduleEnabled && requestMode !== 'script') throw new BadRequest('只有脚本模式可以启用主入口 cron');
    if (scheduleEnabled && !mainScript.trim()) throw new BadRequest('启用 cron 时主入口代码不能为空');

    const record = await createProvider({
      name: requireString(body.name, 'name'),
      baseUrl: requestMode === 'openai' ? requireHttpUrl(body.baseUrl, 'baseUrl') : String(body.baseUrl ?? '').trim(),
      apiKey: requestMode === 'openai' ? requireString(body.apiKey, 'apiKey') : String(body.apiKey ?? '').trim(),
      models: toModels(body.models),
      disabledModels: body.disabledModels === undefined ? undefined : toModels(body.disabledModels),
      systemPrompt: body.systemPrompt === undefined ? '' : String(body.systemPrompt).trim(),
      requestMode,
      requestScript: body.requestScript === undefined ? '' : String(body.requestScript),
      variables: toVariables(body.variables),
      variablesAutoSync: !!body.variablesAutoSync,
      mainScript,
      scheduleEnabled,
      scheduleCron,
      excludeFromModelMatching: !!body.excludeFromModelMatching,
      modelMatchExcludeModels: toModels(body.modelMatchExcludeModels),
      kind,
      source: 'managed',
      priority: toPriority(body.priority),
      enabled: body.enabled === undefined ? true : !!body.enabled,
    });

    invalidateConfig();
    await refreshProviderScriptSchedules();
    const ruleOf = await ruleResolver();
    res.status(201).json(toProviderDTO(record, ruleOf(record)));
  } catch (error) {
    fail(res, error);
  }
});

router.post('/api/providers/test', requireAuth, async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const existing = body.providerId === undefined ? null : await findProviderById(Number(body.providerId));
    if (body.providerId !== undefined && !existing) throw new BadRequest('Provider 不存在');
    const config = (body.provider ?? {}) as Record<string, unknown>;
    const requestMode = toRequestMode(config.requestMode ?? existing?.requestMode);
    const variables = config.variables === undefined
      ? existing?.variables ?? []
      : existing
        ? mergeSecretVariables(existing.variables, toVariables(config.variables))
        : toVariables(config.variables);
    const provider: ProviderRecord = existing
      ? {
          ...existing,
          name: config.name === undefined ? existing.name : requireString(config.name, 'name'),
          baseUrl: config.baseUrl === undefined ? existing.baseUrl : requestMode === 'openai' ? requireHttpUrl(config.baseUrl, 'baseUrl') : String(config.baseUrl).trim(),
          apiKey: config.apiKey ? String(config.apiKey) : existing.apiKey,
          models: config.models === undefined ? existing.models : toModels(config.models),
          systemPrompt: config.systemPrompt === undefined ? existing.systemPrompt : String(config.systemPrompt),
          kind: config.kind === undefined ? existing.kind : toKind(config.kind),
          priority: config.priority === undefined ? existing.priority : toPriority(config.priority),
          requestMode,
          requestScript: config.requestScript === undefined ? existing.requestScript : String(config.requestScript),
          variables,
          variablesAutoSync: config.variablesAutoSync === undefined ? existing.variablesAutoSync : !!config.variablesAutoSync,
          mainScript: config.mainScript === undefined ? existing.mainScript : String(config.mainScript),
          scheduleEnabled: config.scheduleEnabled === undefined ? existing.scheduleEnabled : !!config.scheduleEnabled,
          scheduleCron: config.scheduleCron === undefined ? existing.scheduleCron : String(config.scheduleCron).trim(),
          excludeFromModelMatching:
            config.excludeFromModelMatching === undefined
              ? existing.excludeFromModelMatching
              : !!config.excludeFromModelMatching,
          modelMatchExcludeModels:
            config.modelMatchExcludeModels === undefined
              ? existing.modelMatchExcludeModels
              : toModels(config.modelMatchExcludeModels),
        }
      : {
          id: -1,
          name: requireString(config.name, 'name'),
          baseUrl: requestMode === 'openai' ? requireHttpUrl(config.baseUrl, 'baseUrl') : String(config.baseUrl ?? '').trim(),
          apiKey: String(config.apiKey ?? '').trim(),
          systemPrompt: String(config.systemPrompt ?? ''),
          requestMode,
          requestScript: String(config.requestScript ?? ''),
          variables,
          variablesAutoSync: !!config.variablesAutoSync,
          mainScript: String(config.mainScript ?? ''),
          scheduleEnabled: !!config.scheduleEnabled,
          scheduleCron: String(config.scheduleCron ?? '').trim(),
          excludeFromModelMatching: !!config.excludeFromModelMatching,
          modelMatchExcludeModels: toModels(config.modelMatchExcludeModels),
          scheduleStatus: 'idle',
          lastRunAt: null,
          lastRunOk: null,
          lastRunError: null,
          variablesUpdatedAt: null,
          models: toModels(config.models),
          declaredModels: toModels(config.models),
          disabledModels: [],
          kind: toKind(config.kind),
          source: 'managed',
          priority: toPriority(config.priority),
          enabled: true,
          contributor: null,
          contributorType: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

    const payload = (body.payload ?? {
      model: body.model ?? provider.models[0] ?? 'test-model',
      messages: [{ role: 'user', content: 'ping' }],
    }) as JsonRecord;
    const model = String(body.model ?? payload.model ?? provider.models[0] ?? 'test-model');
    const testVariables = body.variables as Record<string, string | number | boolean> | undefined;
    const effectiveTestVariables = existing && testVariables
      ? Object.fromEntries(Object.entries(testVariables).filter(([name, value]) => {
          const definition = existing.variables.find((item) => item.name === name);
          return !(definition?.type === 'password' && value === '' && definition.defaultValue !== '');
        }))
      : testVariables;
    const configSnapshot = await getConfig();
    const timeoutMs = resolveTimeoutMs(provider, configSnapshot.settings, configSnapshot.groups);
    const upstreamPayload = prependBuiltInSystemPrompt(
      { ...payload, model },
      configSnapshot.settings.globalSystemPromptEnabled ? configSnapshot.settings.globalSystemPrompt : '',
      provider.systemPrompt,
    );

    let status = 200;
    let actualModel = model;
    let responseBody: unknown;
    if (provider.requestMode === 'script') {
      const result = await executeProviderScript(provider, { payload: upstreamPayload, model, signal: new AbortController().signal, variables: effectiveTestVariables }, timeoutMs);
      status = result.status;
      actualModel = result.actualModel;
      responseBody = result.body;
    } else {
      if (!provider.apiKey) throw new BadRequest('OpenAI 模式必须配置 API Key');
      const response = await withTimeout(
        (signal) => getUpstreamClient(provider).chat.completions.create({ ...upstreamPayload, model, stream: false } as never, { signal }),
        timeoutMs,
        `Provider ${provider.name} test timed out after ${timeoutMs}ms`,
      );
      const raw = response as unknown as { model?: string };
      actualModel = raw.model || model;
      responseBody = response;
    }

    const ok = status >= 200 && status < 300;
    res.json({
      ok,
      status,
      elapsedMs: Date.now() - startedAt,
      actualModel,
      response: responseBody,
      ...(ok ? {} : { error: `Provider 返回 HTTP ${status}` }),
    });
  } catch (error) {
    res.json({
      ok: false,
      status: errorStatus(error),
      elapsedMs: Date.now() - startedAt,
      actualModel: null,
      response: null,
      error: errorMessage(error),
    });
  }
});

router.put('/api/providers/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const existing = await findProviderById(id);
    if (!existing) {
      res.status(404).json({ error: { message: 'Provider 不存在' } });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    /*
     * env provider 的连接信息由环境变量单向同步，后台改了也会在下次启动被覆盖，
     * 因此这里直接拒绝，而不是接受一个会静默失效的写入。
     */
    if (existing.source === 'env' && (body.name !== undefined || body.baseUrl !== undefined || body.apiKey)) {
      throw new BadRequest('环境变量来源的 Provider 不能修改名称、Base URL 与 API Key');
    }

    const patch: Parameters<typeof updateProvider>[1] = {};
    if (body.name !== undefined) patch.name = requireString(body.name, 'name');
    if (body.baseUrl !== undefined) {
      const nextMode = body.requestMode === undefined ? existing.requestMode : toRequestMode(body.requestMode);
      patch.baseUrl = nextMode === 'openai' ? requireHttpUrl(body.baseUrl, 'baseUrl') : String(body.baseUrl).trim();
    }
    // 留空表示保持原 key 不变
    if (body.apiKey) patch.apiKey = requireString(body.apiKey, 'apiKey');
    if (body.models !== undefined) patch.models = toModels(body.models);
    if (body.disabledModels !== undefined) patch.disabledModels = toModels(body.disabledModels);
    if (body.systemPrompt !== undefined) patch.systemPrompt = String(body.systemPrompt).trim();
    if (body.requestMode !== undefined) patch.requestMode = toRequestMode(body.requestMode);
    if (body.requestScript !== undefined) patch.requestScript = String(body.requestScript);
    if (body.variables !== undefined) patch.variables = mergeSecretVariables(existing.variables, toVariables(body.variables));
    if (body.variablesAutoSync !== undefined) patch.variablesAutoSync = !!body.variablesAutoSync;
    if (body.mainScript !== undefined) patch.mainScript = String(body.mainScript);
    if (body.scheduleEnabled !== undefined) patch.scheduleEnabled = !!body.scheduleEnabled;
    if (body.scheduleCron !== undefined) patch.scheduleCron = String(body.scheduleCron).trim();
    if (body.excludeFromModelMatching !== undefined) patch.excludeFromModelMatching = !!body.excludeFromModelMatching;
    if (body.modelMatchExcludeModels !== undefined) patch.modelMatchExcludeModels = toModels(body.modelMatchExcludeModels);
    if (body.kind !== undefined) patch.kind = toKind(body.kind);
    if (body.priority !== undefined) patch.priority = toPriority(body.priority);
    if (body.enabled !== undefined) patch.enabled = !!body.enabled;

    const nextRequestMode = patch.requestMode ?? existing.requestMode;
    const nextApiKey = patch.apiKey ?? existing.apiKey;
    const nextMainScript = patch.mainScript ?? existing.mainScript;
    const nextScheduleEnabled = patch.scheduleEnabled ?? existing.scheduleEnabled;
    const nextScheduleCron = toScheduleCron(patch.scheduleCron ?? existing.scheduleCron, nextScheduleEnabled);
    if (patch.scheduleCron !== undefined || patch.scheduleEnabled !== undefined) patch.scheduleCron = nextScheduleCron;
    if (nextScheduleEnabled && nextRequestMode !== 'script') throw new BadRequest('只有脚本模式可以启用主入口 cron');
    if (nextScheduleEnabled && !nextMainScript.trim()) throw new BadRequest('启用 cron 时主入口代码不能为空');
    if (nextRequestMode === 'openai' && !nextApiKey) {
      throw new BadRequest('OpenAI 模式必须配置 API Key');
    }

    const record = await updateProvider(id, patch);
    if (!record) {
      res.status(404).json({ error: { message: 'Provider 不存在' } });
      return;
    }

    if (patch.priority !== undefined && patch.priority !== existing.priority) {
      await pruneEmptyPriorityGroups();
    }

    invalidateConfig();
    await refreshProviderScriptSchedules();
    const ruleOf = await ruleResolver();
    res.json(toProviderDTO(record, ruleOf(record)));
  } catch (error) {
    fail(res, error);
  }
});

router.post('/api/providers/:id/main/run', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await runProviderMain(Number(req.params.id));
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(errorStatus(error)).json({ error: { message: errorMessage(error) } });
  }
});

router.delete('/api/providers/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const existing = await findProviderById(id);
    if (!existing) {
      res.status(404).json({ error: { message: 'Provider 不存在' } });
      return;
    }
    if (existing.source === 'env') throw new BadRequest('环境变量来源的 Provider 不能删除，请从 FALLBACK_PROVIDERS 移除');
    await deleteProvider(id);
    await pruneEmptyPriorityGroups();
    invalidateConfig();
    await refreshProviderScriptSchedules();
    res.json({ success: true });
  } catch (error) {
    fail(res, error);
  }
});
// ------------------------------------------------------------------ 优先级组

router.get('/api/priority-groups', requireAuth, async (_req: Request, res: Response) => {
  try {
    const groups = await listPriorityGroups();
    const payload: PriorityGroupDTO[] = groups.map((group) => ({
      priority: group.priority,
      rule: group.rule,
      timeoutMs: group.timeoutMs,
      providerCount: group.providerCount,
    }));
    res.json(payload);
  } catch (error) {
    fail(res, error);
  }
});

router.put('/api/priority-groups/:priority', requireAuth, async (req: Request, res: Response) => {
  try {
    const priority = toPriority(req.params.priority);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const patch: { rule?: RoutingRule; timeoutMs?: number | null } = {};
    if (body.rule !== undefined) patch.rule = normalizeRoutingRule(body.rule);
    if (body.timeoutMs !== undefined) {
      // null / 空串表示继承全局默认超时
      patch.timeoutMs =
        body.timeoutMs === null || body.timeoutMs === ''
          ? null
          : toPositiveInt(body.timeoutMs, `priority ${priority} 的超时`);
    }

    await savePriorityGroup(priority, patch);
    invalidateConfig();
    res.json({ success: true });
  } catch (error) {
    fail(res, error);
  }
});

// ------------------------------------------------------------------ IP 黑名单

router.get('/api/ip-blacklist', requireAuth, async (_req: Request, res: Response) => {
  try {
    res.json(await listIpBlacklist());
  } catch (error) {
    fail(res, error);
  }
});

router.put('/api/ip-blacklist/:ip', requireAuth, async (req: Request, res: Response) => {
  try {
    const record = await addIpBlacklist(toIp(req.params.ip), toOptionalNote(req.body?.note));
    invalidateConfig();
    res.json(record);
  } catch (error) {
    fail(res, error);
  }
});

router.delete('/api/ip-blacklist/:ip', requireAuth, async (req: Request, res: Response) => {
  try {
    await removeIpBlacklist(toIp(req.params.ip));
    invalidateConfig();
    res.json({ success: true });
  } catch (error) {
    fail(res, error);
  }
});

// ------------------------------------------------------------------ 全局设置

router.get('/api/settings', requireAuth, async (_req: Request, res: Response) => {
  try {
    res.json(await loadSettings());
  } catch (error) {
    fail(res, error);
  }
});

/** 只写入 body 中出现的字段，逐项校验；未提及的配置保持不变 */
router.put('/api/settings', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: SettingsPatch = {};

    if (body.adminEntryEnabled !== undefined) {
      patch.adminEntryEnabled = !!body.adminEntryEnabled;
    }
    if (body.projectUrl !== undefined) {
      patch.projectUrl = requireHttpUrl(body.projectUrl, '项目地址');
    }
    if (body.globalRule !== undefined) patch.globalRule = normalizeRoutingRule(body.globalRule);
    if (body.defaultResponseTimeoutMs !== undefined) {
      patch.defaultResponseTimeoutMs = toPositiveInt(body.defaultResponseTimeoutMs, '主路由默认超时');
    }
    if (body.fallbackResponseTimeoutMs !== undefined) {
      patch.fallbackResponseTimeoutMs = toPositiveInt(body.fallbackResponseTimeoutMs, '保底超时');
    }
    if (body.parallelTimeoutMs !== undefined) {
      patch.parallelTimeoutMs = toPositiveInt(body.parallelTimeoutMs, '并行竞速窗口');
    }
    if (body.ipRateLimitRpm !== undefined) {
      patch.ipRateLimitRpm = toNonNegativeInt(body.ipRateLimitRpm, '同 IP 每分钟请求数限制');
    }
    if (body.ipRateLimitPer10Min !== undefined) {
      patch.ipRateLimitPer10Min = toNonNegativeInt(body.ipRateLimitPer10Min, '同 IP 每 10 分钟请求数限制');
    }
    if (body.ipRateLimitPer30Min !== undefined) {
      patch.ipRateLimitPer30Min = toNonNegativeInt(body.ipRateLimitPer30Min, '同 IP 每 30 分钟请求数限制');
    }
    if (body.ipRateLimitHours !== undefined) {
      patch.ipRateLimitHours = toNonNegativeInt(body.ipRateLimitHours, '自定义限流窗口小时数');
    }
    if (body.ipRateLimitPerXHours !== undefined) {
      patch.ipRateLimitPerXHours = toNonNegativeInt(body.ipRateLimitPerXHours, '自定义窗口请求数限制');
    }
    if (body.maxPrimaryAttempts !== undefined) {
      patch.maxPrimaryAttempts = toPositiveInt(body.maxPrimaryAttempts, '主链最大尝试次数');
    }
    if (body.maxModelRetryCount !== undefined) {
      patch.maxModelRetryCount = toPositiveInt(body.maxModelRetryCount, '单 Provider 模型重试上限');
    }
    if (body.logRetentionDays !== undefined) {
      patch.logRetentionDays = toNonNegativeInt(body.logRetentionDays, '日志保留天数');
    }
    if (body.requestContentLoggingEnabled !== undefined) {
      patch.requestContentLoggingEnabled = !!body.requestContentLoggingEnabled;
    }
    if (body.publicRequestContentStreamEnabled !== undefined) {
      patch.publicRequestContentStreamEnabled = !!body.publicRequestContentStreamEnabled;
    }
    if (body.publicDetailedStatsEnabled !== undefined) {
      patch.publicDetailedStatsEnabled = !!body.publicDetailedStatsEnabled;
    }
    if (body.requestCacheEnabled !== undefined) {
      patch.requestCacheEnabled = !!body.requestCacheEnabled;
    }
    if (body.requestCacheReuseHours !== undefined) {
      patch.requestCacheReuseHours = toPositiveInt(body.requestCacheReuseHours, '请求缓存复用间隔');
    }
    if (body.globalSystemPrompt !== undefined) patch.globalSystemPrompt = String(body.globalSystemPrompt);
    if (body.globalSystemPromptEnabled !== undefined) {
      patch.globalSystemPromptEnabled = !!body.globalSystemPromptEnabled;
    }
    if (body.ideRequestHandlingEnabled !== undefined) {
      patch.ideRequestHandlingEnabled = !!body.ideRequestHandlingEnabled;
    }
    if (body.maliciousRequestHandlingEnabled !== undefined) {
      patch.maliciousRequestHandlingEnabled = !!body.maliciousRequestHandlingEnabled;
    }
    if (body.ideRequestAction !== undefined) patch.ideRequestAction = toIdeAction(body.ideRequestAction);
    if (body.maliciousRequestAction !== undefined) {
      patch.maliciousRequestAction = toMaliciousAction(body.maliciousRequestAction);
    }
    if (body.maliciousResponse !== undefined) patch.maliciousResponse = String(body.maliciousResponse);
    if (body.forbiddenKeywords !== undefined) patch.forbiddenKeywords = String(body.forbiddenKeywords);
    if (body.maliciousThrottleMinutes !== undefined) {
      patch.maliciousThrottleMinutes = toPositiveInt(body.maliciousThrottleMinutes, '拦截/限流时长（分钟）');
    }
    if (body.blockedErrorMessage !== undefined) {
      patch.blockedErrorMessage = String(body.blockedErrorMessage).trim() || '该 IP 已被禁止访问';
    }
    if (body.fuzzyModelMatchingEnabled !== undefined) {
      patch.fuzzyModelMatchingEnabled = !!body.fuzzyModelMatchingEnabled;
    }
    if (body.modelHealthRoutingMode !== undefined) {
      patch.modelHealthRoutingMode = normalizeModelHealthRoutingMode(body.modelHealthRoutingMode);
    }
    if (body.modelCooldownFailureThreshold !== undefined) {
      patch.modelCooldownFailureThreshold = toNonNegativeInt(body.modelCooldownFailureThreshold, '模型冷却失败次数阈值');
    }
    if (body.modelCooldownMinutes !== undefined) {
      patch.modelCooldownMinutes = toPositiveInt(body.modelCooldownMinutes, '模型冷却时长（分钟）');
    }
    if (body.modelEmptyResponseCountsAsFailure !== undefined) {
      patch.modelEmptyResponseCountsAsFailure = !!body.modelEmptyResponseCountsAsFailure;
    }
    if (body.moderationEnabled !== undefined) patch.moderationEnabled = !!body.moderationEnabled;
    if (body.moderationInputEnabled !== undefined) {
      patch.moderationInputEnabled = !!body.moderationInputEnabled;
    }
    if (body.moderationOutputEnabled !== undefined) {
      patch.moderationOutputEnabled = !!body.moderationOutputEnabled;
    }
    if (body.moderationOutputStreamEnabled !== undefined) {
      patch.moderationOutputStreamEnabled = !!body.moderationOutputStreamEnabled;
    }
    if (body.moderationAuditRetentionDays !== undefined) {
      patch.moderationAuditRetentionDays = toNonNegativeInt(
        body.moderationAuditRetentionDays,
        '审核审计日志保留天数',
      );
    }

    const settings = await saveSettings(patch);
    invalidateConfig();
    res.json(settings);
  } catch (error) {
    fail(res, error);
  }
});

// ------------------------------------------------------------------ 请求日志

const OUTCOME_VALUES: readonly RequestOutcome[] = [
  'upstream_ok',
  'cache_hit',
  'upstream_error',
  'client_abort',
  'rejected',
];

function parseListQuery(query: Record<string, unknown>): RequestListQuery {
  const result: RequestListQuery = {};

  if (query.limit !== undefined) result.limit = Number(query.limit) || 50;
  if (query.offset !== undefined) result.offset = Number(query.offset) || 0;
  if (query.success === 'true') result.success = true;
  if (query.success === 'false') result.success = false;
  if (query.requestedModel) result.requestedModel = String(query.requestedModel);
  if (query.ip) result.ip = String(query.ip);
  // 多选值以逗号分隔传递（URL 上保持可读、可分享）
  if (query.outcomes) {
    const outcomes = String(query.outcomes)
      .split(',')
      .map((item) => item.trim())
      .filter((item): item is RequestOutcome => OUTCOME_VALUES.includes(item as RequestOutcome));
    if (outcomes.length > 0) result.outcomes = [...new Set(outcomes)];
  }
  if (query.providerIds) {
    const ids = String(query.providerIds)
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (ids.length > 0) result.providerIds = [...new Set(ids)];
  }
  if (query.from) result.from = String(query.from);
  if (query.to) result.to = String(query.to);

  return result;
}

router.get('/api/requests', requireAuth, async (req: Request, res: Response) => {
  try {
    res.json(await queryRequests(parseListQuery(req.query as Record<string, unknown>)));
  } catch (error) {
    fail(res, error);
  }
});

router.get('/api/requests/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const detail = await getRequestDetail(Number(req.params.id));
    if (!detail) {
      res.status(404).json({ error: { message: '请求记录不存在' } });
      return;
    }
    res.json(detail);
  } catch (error) {
    fail(res, error);
  }
});

// 单 IP 详细统计（日志页右键「查看统计信息」）；无数据返回 404 而不是空对象，让前端能区分
router.get('/api/ip-stats/:ip', requireAuth, async (req: Request, res: Response) => {
  try {
    const stats = await getIpDetailStats(toIp(req.params.ip), parseRange(req.query as Record<string, unknown>));
    if (!stats) {
      res.status(404).json({ error: { message: '该 IP 在统计范围内没有请求记录' } });
      return;
    }
    res.json(stats);
  } catch (error) {
    fail(res, error);
  }
});

// ------------------------------------------------------------------ 用量统计

function parseRange(query: Record<string, unknown>): { from?: string; to?: string } {
  const range: { from?: string; to?: string } = {};
  if (query.from) range.from = String(query.from).slice(0, 10);
  if (query.to) range.to = String(query.to).slice(0, 10);
  return range;
}

router.get('/api/dashboard', requireAuth, async (req: Request, res: Response) => {
  try {
    res.json(await getDashboardSummary(parseRange(req.query as Record<string, unknown>)));
  } catch (error) {
    fail(res, error);
  }
});

/** 统一的用量入口，dimension 决定聚合维度 */
router.get('/api/usage', requireAuth, async (req: Request, res: Response) => {
  try {
    const range = parseRange(req.query as Record<string, unknown>);
    const dimension = String(req.query.dimension ?? 'provider');

    if (dimension === 'daily') {
      res.json(await getDailyUsage(range));
      return;
    }
    if (dimension === 'model') {
      res.json(await getModelUsage(range));
      return;
    }
    if (dimension === 'ip') {
      res.json(await getIpUsage(range));
      return;
    }
    if (dimension === 'provider') {
      res.json(await getProviderUsage(range));
      return;
    }

    throw new BadRequest('dimension 只允许 daily / provider / model / ip');
  } catch (error) {
    fail(res, error);
  }
});

/**
 * 端点健康（后台「状态监控」页）。
 *
 * 只读 endpoint_health_daily 的日聚合：窗口固定 30 天，7 / 15 / 30 天可用率
 * 由同一份逐日样本切出；没有「选择窗口」参数，避免多个口径彼此漂移。
 */
router.get('/api/endpoint-health', requireAuth, async (_req: Request, res: Response) => {
  try {
    res.json(await getEndpointHealth());
  } catch (error) {
    fail(res, error);
  }
});

/** 渠道弹窗：单个渠道按声明模型拆分的健康状态 */
router.get('/api/providers/:id/model-health', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequest('Provider 不存在');
    const data = await getChannelModelHealth(id);
    if (!data) {
      res.status(404).json({ error: { message: 'Provider 不存在' } });
      return;
    }
    res.json(data);
  } catch (error) {
    fail(res, error);
  }
});

/** 停用 / 恢复渠道声明的某个模型（停用 = 路由视为无该模型） */
router.put('/api/providers/:id/models/:model/enabled', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const existing = await findProviderById(id);
    if (!existing) {
      res.status(404).json({ error: { message: 'Provider 不存在' } });
      return;
    }
    const model = String(req.params.model ?? '').trim();
    if (!model || !existing.declaredModels.includes(model)) {
      throw new BadRequest('该模型不在渠道声明列表中');
    }
    const enabled = req.body?.enabled !== false;

    await setProviderModelEnabled(id, model, enabled);
    invalidateConfig();
    res.json({ success: true });
  } catch (error) {
    fail(res, error);
  }
});

// ------------------------------------------------------------------ 运行时状态

/** 暴露内存结构规模，用于确认缓存与队列没有异常增长 */
router.get('/api/runtime', requireAuth, (_req: Request, res: Response) => {
  const snapshot = peekConfig();

  res.json({
    config: {
      cached: !!snapshot,
      loadedAt: snapshot ? new Date(snapshot.loadedAtMs).toISOString() : null,
      providerCount: snapshot?.providers.length ?? 0,
      groupCount: snapshot?.groups.size ?? 0,
    },
    writeQueue: getWriteQueueStats(),
    counters: counterStats(),
    upstreamClients: upstreamClientCount(),
    uptimeSec: Math.round(process.uptime()),
  });
});

/** 手动触发一次保留清理，避免只能等 6 小时的后台周期 */
router.post('/api/retention/sweep', requireAuth, async (_req: Request, res: Response) => {
  try {
    res.json({ deleted: await runRetentionSweep() });
  } catch (error) {
    fail(res, error);
  }
});

// ------------------------------------------------------------------ 公告

const ANNOUNCEMENT_LEVELS: readonly AnnouncementLevel[] = ['info', 'warning', 'success'];

function toAnnouncementDTO(record: {
  id: number;
  title: string;
  body: string;
  level: AnnouncementLevel;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}): AnnouncementDTO {
  return {
    id: record.id,
    title: record.title,
    body: record.body,
    level: record.level,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function parseAnnouncementInput(body: Record<string, unknown>, partial: boolean): Partial<AnnouncementInput> {
  const input: Partial<AnnouncementInput> = {};

  if (!partial || body.title !== undefined) input.title = requireString(body.title, '标题').slice(0, 120);
  if (!partial || body.body !== undefined) input.body = requireString(body.body, '正文').slice(0, 5000);
  if (!partial || body.level !== undefined) {
    const level = String(body.level ?? 'info');
    if (!ANNOUNCEMENT_LEVELS.includes(level as AnnouncementLevel)) {
      throw new BadRequest('级别只允许 info / warning / success');
    }
    input.level = level as AnnouncementLevel;
  }
  if (!partial || body.enabled !== undefined) input.enabled = body.enabled === undefined ? true : !!body.enabled;

  return input;
}

router.get('/api/announcements', requireAuth, async (_req: Request, res: Response) => {
  try {
    res.json((await listAnnouncements()).map(toAnnouncementDTO));
  } catch (error) {
    fail(res, error);
  }
});

router.post('/api/announcements', requireAuth, async (req: Request, res: Response) => {
  try {
    const input = parseAnnouncementInput((req.body ?? {}) as Record<string, unknown>, false) as AnnouncementInput;
    const record = await createAnnouncement(input);
    res.status(201).json(toAnnouncementDTO(record));
  } catch (error) {
    fail(res, error);
  }
});

router.put('/api/announcements/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const existing = await findAnnouncementById(id);
    if (!existing) {
      res.status(404).json({ error: { message: '公告不存在' } });
      return;
    }

    const patch = parseAnnouncementInput((req.body ?? {}) as Record<string, unknown>, true);
    const record = await updateAnnouncement(id, patch);
    if (!record) {
      res.status(404).json({ error: { message: '公告不存在' } });
      return;
    }
    res.json(toAnnouncementDTO(record));
  } catch (error) {
    fail(res, error);
  }
});

router.delete('/api/announcements/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const deleted = await deleteAnnouncement(Number(req.params.id));
    if (!deleted) {
      res.status(404).json({ error: { message: '公告不存在' } });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    fail(res, error);
  }
});

// ------------------------------------------------------------------ 内容审核

const COMBINE_MODES: readonly ModerationCombineMode[] = ['strict', 'majority', 'lenient'];
const OUTPUT_ACTIONS: readonly ModerationOutputAction[] = ['empty', 'error', 'response'];

function toCombineMode(value: unknown): ModerationCombineMode {
  if (COMBINE_MODES.includes(value as ModerationCombineMode)) return value as ModerationCombineMode;
  throw new BadRequest('审核组合模式只允许 strict / majority / lenient');
}

function toOutputAction(value: unknown): ModerationOutputAction {
  if (OUTPUT_ACTIONS.includes(value as ModerationOutputAction)) return value as ModerationOutputAction;
  throw new BadRequest('输出审核处理方式只允许 empty / error / response');
}

function toModerationCategory(value: unknown): ModerationCategory {
  if (typeof value === 'string' && (MODERATION_CATEGORIES as readonly string[]).includes(value)) {
    return value as ModerationCategory;
  }
  throw new BadRequest(`未知审核类别：${String(value)}`);
}

function toCategorySettings(value: unknown): ModerationCategorySettingDTO[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new BadRequest('categories 必须是数组');
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new BadRequest(`第 ${index + 1} 个类别配置无效`);
    const item = raw as Record<string, unknown>;
    const category = toModerationCategory(item.category);
    const sensitivity = Number(item.sensitivity ?? 50);
    if (!Number.isFinite(sensitivity) || sensitivity < 0 || sensitivity > 100) {
      throw new BadRequest(`类别 ${category} 的敏感度必须是 0-100 的整数`);
    }
    return {
      category,
      enabled: item.enabled === undefined ? true : !!item.enabled,
      sensitivity: Math.round(sensitivity),
    };
  });
}

function toDetectorSettings(value: unknown): ModerationDetectorSettingDTO[] {
  if (value === undefined) return defaultDetectorSettings();
  if (!Array.isArray(value)) throw new BadRequest('detectors 必须是数组');
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new BadRequest(`第 ${index + 1} 个引擎配置无效`);
    const item = raw as Record<string, unknown>;
    const detectorId = requireString(item.detectorId, `第 ${index + 1} 个引擎 id`);
    if (!detectorById(detectorId)) throw new BadRequest(`未知检测引擎：${detectorId}`);
    const categories = Array.isArray(item.categories) ? item.categories.map(toModerationCategory) : [];
    return {
      detectorId,
      enabled: item.enabled === undefined ? true : !!item.enabled,
      categories,
    };
  });
}

function toModerationScope(value: unknown): ModerationScopeType {
  if (value === 'provider' || value === 'model') return value;
  throw new BadRequest('作用域只允许 provider / model');
}

router.get('/api/moderation/policies', requireAuth, async (_req: Request, res: Response) => {
  try {
    res.json(await listModerationPolicies());
  } catch (error) {
    fail(res, error);
  }
});

router.get('/api/moderation/detectors', requireAuth, (_req: Request, res: Response) => {
  res.json(listDetectorInfo());
});

router.get('/api/moderation/categories', requireAuth, (_req: Request, res: Response) => {
  res.json(
    MODERATION_CATEGORIES.map((category) => {
      const meta = categoryMeta(category);
      return {
        category: meta.id,
        label: meta.label,
        parent: meta.parent,
        defaultSensitivity: meta.defaultSensitivity,
      };
    }),
  );
});

router.post('/api/moderation/policies', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input: ModerationPolicyInput = {
      name: requireString(body.name, '策略名称'),
      description: body.description === undefined ? '' : String(body.description),
      enabled: body.enabled === undefined ? true : !!body.enabled,
      isDefault: !!body.isDefault,
      combineMode: body.combineMode === undefined ? 'strict' : toCombineMode(body.combineMode),
      action: body.action === undefined ? 'empty' : toMaliciousAction(body.action),
      outputAction: body.outputAction === undefined ? 'empty' : toOutputAction(body.outputAction),
      outputResponse: body.outputResponse === undefined ? '' : String(body.outputResponse),
      response: body.response === undefined ? '' : String(body.response),
      holdBackChars: body.holdBackChars === undefined ? 96 : toNonNegativeInt(body.holdBackChars, '滞后窗口字符数'),
      forbiddenKeywords: body.forbiddenKeywords === undefined ? '' : String(body.forbiddenKeywords),
      categories: toCategorySettings(body.categories),
      detectors: toDetectorSettings(body.detectors),
    };
    const created = await createModerationPolicy(input);
    invalidateConfig();
    res.status(201).json(created);
  } catch (error) {
    fail(res, error);
  }
});

router.put('/api/moderation/policies/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const existing = await findModerationPolicyById(id);
    if (!existing) {
      res.status(404).json({ error: { message: '审核策略不存在' } });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<ModerationPolicyInput> = {};
    if (body.name !== undefined) patch.name = requireString(body.name, '策略名称');
    if (body.description !== undefined) patch.description = String(body.description);
    if (body.enabled !== undefined) patch.enabled = !!body.enabled;
    if (body.isDefault !== undefined) patch.isDefault = !!body.isDefault;
    if (body.combineMode !== undefined) patch.combineMode = toCombineMode(body.combineMode);
    if (body.action !== undefined) patch.action = toMaliciousAction(body.action);
    if (body.outputAction !== undefined) patch.outputAction = toOutputAction(body.outputAction);
    if (body.outputResponse !== undefined) patch.outputResponse = String(body.outputResponse);
    if (body.response !== undefined) patch.response = String(body.response);
    if (body.holdBackChars !== undefined) {
      patch.holdBackChars = toNonNegativeInt(body.holdBackChars, '滞后窗口字符数');
    }
    if (body.forbiddenKeywords !== undefined) patch.forbiddenKeywords = String(body.forbiddenKeywords);
    if (body.categories !== undefined) patch.categories = toCategorySettings(body.categories);
    if (body.detectors !== undefined) patch.detectors = toDetectorSettings(body.detectors);

    const updated = await updateModerationPolicy(id, patch);
    invalidateConfig();
    res.json(updated);
  } catch (error) {
    const message = (error as Error)?.message ?? '';
    if (/unique/i.test(message)) {
      res.status(409).json({ error: { message: '策略名称已存在' } });
      return;
    }
    fail(res, error);
  }
});

router.delete('/api/moderation/policies/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const deleted = await deleteModerationPolicy(Number(req.params.id));
    if (!deleted) {
      res.status(404).json({ error: { message: '审核策略不存在' } });
      return;
    }
    invalidateConfig();
    res.json({ success: true });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/api/moderation/bindings', requireAuth, async (_req: Request, res: Response) => {
  try {
    res.json(await listModerationBindings());
  } catch (error) {
    fail(res, error);
  }
});

router.put('/api/moderation/bindings', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const scopeType = toModerationScope(body.scopeType);
    const providerId = Number(body.providerId);
    if (!Number.isInteger(providerId) || providerId <= 0) throw new BadRequest('Provider id 无效');
    const policyId = Number(body.policyId);
    if (!Number.isInteger(policyId) || policyId <= 0) throw new BadRequest('策略 id 无效');

    const policy = await findModerationPolicyById(policyId);
    if (!policy) throw new BadRequest('绑定的策略不存在');

    let model: string | null = null;
    if (scopeType === 'model') {
      model = requireString(body.model, '模型名');
    }

    await upsertModerationBinding({ scopeType, providerId, model, policyId });
    invalidateConfig();
    res.json({ success: true });
  } catch (error) {
    fail(res, error);
  }
});

router.delete('/api/moderation/bindings/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const deleted = await deleteModerationBinding(Number(req.params.id));
    if (!deleted) {
      res.status(404).json({ error: { message: '绑定不存在' } });
      return;
    }
    invalidateConfig();
    res.json({ success: true });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/api/moderation/events', requireAuth, async (req: Request, res: Response) => {
  try {
    const query: ModerationEventQuery = {};
    const raw = req.query as Record<string, unknown>;
    if (raw.limit !== undefined) query.limit = Number(raw.limit) || 50;
    if (raw.offset !== undefined) query.offset = Number(raw.offset) || 0;
    if (raw.stage === 'input' || raw.stage === 'output') query.stage = raw.stage;
    if (raw.category) query.category = toModerationCategory(raw.category);
    if (raw.blockedOnly === 'true') query.blockedOnly = true;
    if (raw.from) query.from = String(raw.from);
    if (raw.to) query.to = String(raw.to);

    res.json(await queryModerationEvents(query));
  } catch (error) {
    fail(res, error);
  }
});

export default router;