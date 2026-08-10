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
  updateProvider,
  type ProviderRecord,
} from '../db/repo/providers';
import { getRequestDetail, queryRequests } from '../db/repo/requests';
import { loadSettings, normalizeRoutingRule, saveSettings } from '../db/repo/settings';
import {
  getDailyUsage,
  getDashboardSummary,
  getIpUsage,
  getModelUsage,
  getProviderUsage,
} from '../db/repo/usage';
import { getConfig, invalidateConfig, peekConfig } from '../runtime/config-cache';
import { counterStats } from '../runtime/counters';
import { getWriteQueueStats } from '../runtime/write-queue';
import { runRetentionSweep } from '../runtime/retention';
import { upstreamClientCount } from '../upstream/client';
import type {
  PriorityGroupDTO,
  ProviderKind,
  RequestListQuery,
  RoutingRule,
  SettingsPatch,
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

  console.error(`[Admin] ${message}`);
  res.status(500).json({ error: { message } });
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

    const record = await createProvider({
      name: requireString(body.name, 'name'),
      baseUrl: requireHttpUrl(body.baseUrl, 'baseUrl'),
      apiKey: requireString(body.apiKey, 'apiKey'),
      models: toModels(body.models),
      kind,
      source: 'managed',
      priority: toPriority(body.priority),
      enabled: body.enabled === undefined ? true : !!body.enabled,
    });

    invalidateConfig();
    const ruleOf = await ruleResolver();
    res.status(201).json(toProviderDTO(record, ruleOf(record)));
  } catch (error) {
    fail(res, error);
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
    if (body.baseUrl !== undefined) patch.baseUrl = requireHttpUrl(body.baseUrl, 'baseUrl');
    // 留空表示保持原 key 不变
    if (body.apiKey) patch.apiKey = requireString(body.apiKey, 'apiKey');
    if (body.models !== undefined) patch.models = toModels(body.models);
    if (body.kind !== undefined) patch.kind = toKind(body.kind);
    if (body.priority !== undefined) patch.priority = toPriority(body.priority);
    if (body.enabled !== undefined) patch.enabled = !!body.enabled;

    const record = await updateProvider(id, patch);
    if (!record) {
      res.status(404).json({ error: { message: 'Provider 不存在' } });
      return;
    }

    if (patch.priority !== undefined && patch.priority !== existing.priority) {
      await pruneEmptyPriorityGroups();
    }

    invalidateConfig();
    const ruleOf = await ruleResolver();
    res.json(toProviderDTO(record, ruleOf(record)));
  } catch (error) {
    fail(res, error);
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
    if (existing.source === 'env') {
      throw new BadRequest('环境变量来源的 Provider 不能删除，请从 FALLBACK_PROVIDERS 移除');
    }

    await deleteProvider(id);
    await pruneEmptyPriorityGroups();
    invalidateConfig();

    // 历史用量靠 provider_usage_daily 的反规范化 provider_name 保留，删除不影响追溯
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

    const settings = await saveSettings(patch);
    invalidateConfig();
    res.json(settings);
  } catch (error) {
    fail(res, error);
  }
});

// ------------------------------------------------------------------ 请求日志

function parseListQuery(query: Record<string, unknown>): RequestListQuery {
  const result: RequestListQuery = {};

  if (query.limit !== undefined) result.limit = Number(query.limit) || 50;
  if (query.offset !== undefined) result.offset = Number(query.offset) || 0;
  if (query.success === 'true') result.success = true;
  if (query.success === 'false') result.success = false;
  if (query.requestedModel) result.requestedModel = String(query.requestedModel);
  if (query.ip) result.ip = String(query.ip);
  if (query.providerId !== undefined) {
    const id = Number(query.providerId);
    if (Number.isFinite(id)) result.providerId = id;
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

export default router;