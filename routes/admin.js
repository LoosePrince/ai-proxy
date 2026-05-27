const express = require('express');
const session = require('express-session');
const path = require('path');
const prisma = require('../lib/prisma');
const { getLogs, aggregateAllStats, ensureStatsProviders } = require('../lib/stats');
const {
  ensureGlobalRouteController,
  explainResolvedRouting,
  normalizeGlobalModelConfig,
  normalizeRoutingRule,
  updateGlobalModelConfig,
} = require('../lib/provider');

const router = express.Router();

const MIGRATION_REQUIRED_MESSAGE = '数据库结构未完成迁移，请执行 npx prisma migrate deploy 或重启服务触发自动补列';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const NEED_AUTH = !!(ADMIN_USERNAME && ADMIN_PASSWORD);

// Session 中间件（仅 admin 路由使用）
router.use(session({
  secret: process.env.SESSION_SECRET || 'ai-proxy-admin-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 3600_000, httpOnly: true },
}));

// 认证中间件
function requireAuth(req, res, next) {
  if (!NEED_AUTH) return next();
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Authentication required' });
}

function isMissingContributionColumn(error) {
  return error.code === 'P2022' || /isContributed/i.test(error.message || '');
}

function withContributionFallback(provider) {
  return { ...provider, isContributed: false };
}

const providerSelectWithoutContribution = {
  id: true,
  name: true,
  baseUrl: true,
  apiKey: true,
  models: true,
  rule: true,
  priority: true,
  enabled: true,
  isEnv: true,
  stats: true,
  createdAt: true,
  updatedAt: true,
};

async function findProviderByIdCompat(id) {
  const provider = await prisma.provider.findUnique({
    where: { id },
    select: providerSelectWithoutContribution,
  });
  return provider ? withContributionFallback(provider) : null;
}

async function updateProviderCompat(id, data) {
  const provider = await prisma.provider.update({
    where: { id },
    data,
    select: providerSelectWithoutContribution,
  });
  return withContributionFallback(provider);
}

async function createProviderCompat(data) {
  const provider = await prisma.provider.create({
    data,
    select: providerSelectWithoutContribution,
  });
  return withContributionFallback(provider);
}

async function findProvidersCompat(args = {}) {
  try {
    return await prisma.provider.findMany(args);
  } catch (error) {
    if (!isMissingContributionColumn(error)) throw error;
    const rows = await prisma.$queryRaw`
      SELECT id, name, "baseUrl", "apiKey", models, rule, priority, enabled, "isEnv", stats, "createdAt", "updatedAt"
      FROM "Provider"
      ORDER BY priority ASC, id ASC
    `;
    return rows.map(withContributionFallback);
  }
}

async function syncPriorityGroupRule(priority, rule, excludeId = null) {
  const numericPriority = Number(priority);
  if (numericPriority < 0) return;
  const normalizedRule = normalizeRoutingRule(rule);
  await prisma.provider.updateMany({
    where: {
      priority: numericPriority,
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
    data: { rule: normalizedRule },
  });
}

// --- 登录/登出 ---

router.post('/api/login', (req, res) => {
  if (!NEED_AUTH) {
    return res.json({ success: true });
  }
  const { username, password } = req.body || {};
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

router.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

router.get('/api/auth-check', (req, res) => {
  if (!NEED_AUTH) return res.json({ authenticated: true, needAuth: false });
  res.json({ authenticated: !!req.session.authenticated, needAuth: true });
});

// --- Provider CRUD ---

router.get('/api/providers', requireAuth, async (req, res) => {
  try {
    await ensureGlobalRouteController();
    const providers = await findProvidersCompat({ orderBy: [{ priority: 'asc' }, { id: 'asc' }] });
    const routingState = await explainResolvedRouting(null);
    const groupRuleMap = new Map(
      (routingState.routing?.groups || []).map((group) => [Number(group.priority), group.internalRule]),
    );
    // 隐藏 apiKey，仅显示前后4位
    const masked = providers
      .filter((p) => Number(p.priority) >= 0)
      .map(p => ({
        ...p,
        isVirtualController: false,
        effectiveRule: groupRuleMap.get(Number(p.priority)) || normalizeRoutingRule(p.rule),
        routeScope: 'internal',
        apiKey: p.apiKey.length > 8
          ? p.apiKey.slice(0, 4) + '***' + p.apiKey.slice(-4)
          : '***',
      }));
    res.json(masked);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function sanitizeGlobalModelConfigForResponse(config) {
  const normalized = normalizeGlobalModelConfig(config || {});
  return {
    ...normalized,
    fallbackProvider: {
      ...normalized.fallbackProvider,
      apiKey: '',
      hasApiKey: !!normalized.fallbackProvider.apiKey,
    },
    parallelProvider: {
      ...normalized.parallelProvider,
      apiKey: '',
      hasApiKey: !!normalized.parallelProvider.apiKey,
    },
  };
}

function mergeGlobalModelConfigInput(currentConfig, inputConfig) {
  const current = normalizeGlobalModelConfig(currentConfig || {});
  const input = inputConfig || {};
  return normalizeGlobalModelConfig({
    ...current,
    ...input,
    fallbackProvider: {
      ...current.fallbackProvider,
      ...(input.fallbackProvider || {}),
      apiKey: input.fallbackProvider?.apiKey || current.fallbackProvider.apiKey,
    },
    parallelProvider: {
      ...current.parallelProvider,
      ...(input.parallelProvider || {}),
      apiKey: input.parallelProvider?.apiKey || current.parallelProvider.apiKey,
    },
    priorityTimeouts: input.priorityTimeouts !== undefined ? input.priorityTimeouts : current.priorityTimeouts,
  });
}

function validateTimeoutValue(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return `${label} 必须是大于 0 的毫秒数`;
  return null;
}

function validatePriorityTimeouts(priorityTimeouts) {
  if (priorityTimeouts === undefined || priorityTimeouts === null) return null;
  if (typeof priorityTimeouts !== 'object' || Array.isArray(priorityTimeouts)) {
    return 'priority 超时配置必须是对象';
  }

  for (const [priority, timeoutMs] of Object.entries(priorityTimeouts)) {
    const priorityNumber = Number(priority);
    if (!Number.isInteger(priorityNumber) || priorityNumber < 0) {
      return `priority 超时配置中的优先级「${priority}」无效，只允许大于等于 0 的整数`;
    }
    const timeoutError = validateTimeoutValue(timeoutMs, `priority ${priorityNumber} 的超时`);
    if (timeoutError) return timeoutError;
  }

  return null;
}

function validateGlobalModelConfigInput(inputConfig = {}) {
  const defaultTimeoutError = validateTimeoutValue(inputConfig.defaultResponseTimeoutMs, '主路由默认超时');
  if (defaultTimeoutError) return defaultTimeoutError;
  const fallbackTimeoutError = validateTimeoutValue(inputConfig.fallbackResponseTimeoutMs, '保底超时');
  if (fallbackTimeoutError) return fallbackTimeoutError;
  const parallelTimeoutError = validateTimeoutValue(inputConfig.parallelTimeoutMs, '并行竞速窗口');
  if (parallelTimeoutError) return parallelTimeoutError;
  return validatePriorityTimeouts(inputConfig.priorityTimeouts);
}

function validateSpecialProviderConfig(provider, label) {
  if (!provider?.enabled) return null;
  if (!provider.baseUrl || !provider.apiKey) return `${label} 已启用时必须填写 Base URL 和 API Key`;
  if (!/^https?:\/\//i.test(provider.baseUrl)) return `${label} 的 Base URL 必须以 http:// 或 https:// 开头`;
  return null;
}

router.get('/api/global-route', requireAuth, async (req, res) => {
  try {
    const controller = await ensureGlobalRouteController();
    const full = await findProviderByIdCompat(controller.id);
    res.json({
      id: full.id,
      rule: normalizeRoutingRule(full.rule),
      enabled: full.enabled,
      priority: full.priority,
      modelConfig: sanitizeGlobalModelConfigForResponse(full.stats?.modelConfig || {}),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/api/global-route', requireAuth, async (req, res) => {
  try {
    const controller = await ensureGlobalRouteController();
    const data = {};
    if (req.body.rule !== undefined) data.rule = normalizeRoutingRule(req.body.rule);
    if (req.body.enabled !== undefined) data.enabled = !!req.body.enabled;
    if (req.body.modelConfig !== undefined) {
      const inputModelConfig = req.body.modelConfig || {};
      const modelConfigError = validateGlobalModelConfigInput(inputModelConfig);
      if (modelConfigError) {
        return res.status(400).json({ error: modelConfigError });
      }
      const current = await findProviderByIdCompat(controller.id);
      const modelConfig = mergeGlobalModelConfigInput(current?.stats?.modelConfig || {}, inputModelConfig);
      const fallbackError = validateSpecialProviderConfig(modelConfig.fallbackProvider, '保底 Provider');
      const parallelError = validateSpecialProviderConfig(modelConfig.parallelProvider, '并行 Provider');
      if (fallbackError || parallelError) {
        return res.status(400).json({ error: fallbackError || parallelError });
      }
      await updateGlobalModelConfig(modelConfig);
    }
    const updated = Object.keys(data).length ? await updateProviderCompat(controller.id, data) : await findProviderByIdCompat(controller.id);
    const latest = await findProviderByIdCompat(controller.id);
    const modelConfig = sanitizeGlobalModelConfigForResponse(latest?.stats?.modelConfig || {});
    res.json({
      id: updated.id,
      rule: normalizeRoutingRule(updated.rule),
      enabled: updated.enabled,
      priority: updated.priority,
      modelConfig,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/providers', requireAuth, async (req, res) => {
  try {
    const { name, baseUrl, apiKey, models, rule, priority } = req.body;
    const normalizedPriority = Number(priority ?? 0);
    if (normalizedPriority < 0) {
      return res.status(400).json({ error: 'priority < 0 保留给虚拟全局控制条目，不能手动创建' });
    }
    if (!name || !baseUrl || !apiKey) {
      return res.status(400).json({ error: 'name, baseUrl, apiKey are required' });
    }
    const normalizedRule = normalizeRoutingRule(rule || 'priority');
    const provider = await createProviderCompat({
      name,
      baseUrl,
      apiKey,
      models: models || [],
      rule: normalizedRule,
      priority: normalizedPriority,
      isEnv: false,
      enabled: true,
      stats: {},
    });
    await syncPriorityGroupRule(normalizedPriority, normalizedRule, provider.id);
    res.json(provider);
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: `Provider "${req.body.name}" already exists` });
    }
    if (isMissingContributionColumn(err)) {
      return res.status(503).json({ error: MIGRATION_REQUIRED_MESSAGE });
    }
    res.status(500).json({ error: err.message });
  }
});

router.put('/api/providers/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await findProviderByIdCompat(id);
    if (!existing) return res.status(404).json({ error: 'Provider not found' });

    const body = req.body;
    const isVirtualController = Number(existing.priority) < 0;

    if (isVirtualController) {
      const allowed = {};
      if (body.rule !== undefined) allowed.rule = normalizeRoutingRule(body.rule);
      if (body.enabled !== undefined) allowed.enabled = body.enabled;
      const updated = await updateProviderCompat(id, allowed);
      return res.json(updated);
    }

    if (existing.isEnv) {
      // isEnv 的 provider 仅允许改 models, rule, priority, enabled
      const allowed = {};
      if (body.models !== undefined) allowed.models = body.models;
      if (body.rule !== undefined) allowed.rule = normalizeRoutingRule(body.rule);
      if (body.priority !== undefined) allowed.priority = Number(body.priority);
      if (body.enabled !== undefined) allowed.enabled = body.enabled;
      const targetPriority = allowed.priority !== undefined ? allowed.priority : existing.priority;
      const targetRule = allowed.rule !== undefined ? allowed.rule : existing.rule;
      const oldPriority = Number(existing.priority);
      const updated = await updateProviderCompat(id, allowed);
      if (oldPriority >= 0 && oldPriority !== targetPriority) {
        await syncPriorityGroupRule(oldPriority, existing.rule, updated.id);
      }
      await syncPriorityGroupRule(targetPriority, targetRule, updated.id);
      return res.json(updated);
    }

    // 普通 provider 可改所有字段
    const data = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.baseUrl !== undefined) data.baseUrl = body.baseUrl;
    // 跳过脱敏的 apiKey（含 ***）避免覆盖真实 key
    if (body.apiKey !== undefined && !body.apiKey.includes('***')) data.apiKey = body.apiKey;
    if (body.models !== undefined) data.models = body.models;
    if (body.rule !== undefined) data.rule = normalizeRoutingRule(body.rule);
    if (body.priority !== undefined) data.priority = Number(body.priority);
    if (body.enabled !== undefined) data.enabled = body.enabled;

    const oldPriority = Number(existing.priority);
    const targetPriority = data.priority !== undefined ? data.priority : oldPriority;
    const targetRule = data.rule !== undefined ? data.rule : existing.rule;
    const updated = await updateProviderCompat(id, data);
    if (oldPriority >= 0 && oldPriority !== targetPriority) {
      await syncPriorityGroupRule(oldPriority, existing.rule, updated.id);
    }
    await syncPriorityGroupRule(targetPriority, targetRule, updated.id);
    res.json(updated);
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: `Provider name "${req.body.name}" already exists` });
    }
    if (isMissingContributionColumn(err)) {
      return res.status(503).json({ error: MIGRATION_REQUIRED_MESSAGE });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/providers/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await findProviderByIdCompat(id);
    if (!existing) return res.status(404).json({ error: 'Provider not found' });
    if (existing.isEnv) return res.status(403).json({ error: 'Cannot delete env provider' });
    if (Number(existing.priority) < 0) return res.status(403).json({ error: 'Cannot delete virtual global controller' });

    await prisma.provider.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    if (isMissingContributionColumn(err)) {
      return res.status(503).json({ error: MIGRATION_REQUIRED_MESSAGE });
    }
    res.status(500).json({ error: err.message });
  }
});

// --- 统计 ---

router.get('/api/stats', requireAuth, async (req, res) => {
  try {
    await ensureStatsProviders();
    const providers = await findProvidersCompat();
    const stats = aggregateAllStats(providers);
    res.json(stats);
  } catch (err) {
    if (isMissingContributionColumn(err)) {
      return res.status(503).json({ error: MIGRATION_REQUIRED_MESSAGE });
    }
    res.status(500).json({ error: err.message });
  }
});

// --- 内存日志 ---

router.get('/api/logs', requireAuth, (req, res) => {
  res.json(getLogs());
});

// --- Admin 页面 ---

router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

module.exports = router;