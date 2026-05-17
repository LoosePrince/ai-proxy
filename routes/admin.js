const express = require('express');
const session = require('express-session');
const path = require('path');
const prisma = require('../lib/prisma');
const { getLogs, aggregateAllStats } = require('../lib/stats');

const router = express.Router();

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
    const providers = await prisma.provider.findMany({ orderBy: { priority: 'asc' } });
    // 隐藏 apiKey，仅显示前后4位
    const masked = providers.map(p => ({
      ...p,
      apiKey: p.apiKey.length > 8
        ? p.apiKey.slice(0, 4) + '***' + p.apiKey.slice(-4)
        : '***',
    }));
    res.json(masked);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/providers', requireAuth, async (req, res) => {
  try {
    const { name, baseUrl, apiKey, models, rule, priority } = req.body;
    if (!name || !baseUrl || !apiKey) {
      return res.status(400).json({ error: 'name, baseUrl, apiKey are required' });
    }
    const provider = await prisma.provider.create({
      data: {
        name,
        baseUrl,
        apiKey,
        models: models || [],
        rule: rule || 'priority',
        priority: priority ?? 0,
        isEnv: false,
        enabled: true,
        stats: {},
      },
    });
    res.json(provider);
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: `Provider "${req.body.name}" already exists` });
    }
    res.status(500).json({ error: err.message });
  }
});

router.put('/api/providers/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.provider.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Provider not found' });

    const body = req.body;

    if (existing.isEnv) {
      // isEnv 的 provider 仅允许改 models, rule, priority, enabled
      const allowed = {};
      if (body.models !== undefined) allowed.models = body.models;
      if (body.rule !== undefined) allowed.rule = body.rule;
      if (body.priority !== undefined) allowed.priority = body.priority;
      // isEnv 不允许关闭
      if (body.enabled !== undefined && body.enabled === true) allowed.enabled = true;
      const updated = await prisma.provider.update({ where: { id }, data: allowed });
      return res.json(updated);
    }

    // 普通 provider 可改所有字段
    const data = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.baseUrl !== undefined) data.baseUrl = body.baseUrl;
    // 跳过脱敏的 apiKey（含 ***）避免覆盖真实 key
    if (body.apiKey !== undefined && !body.apiKey.includes('***')) data.apiKey = body.apiKey;
    if (body.models !== undefined) data.models = body.models;
    if (body.rule !== undefined) data.rule = body.rule;
    if (body.priority !== undefined) data.priority = body.priority;
    if (body.enabled !== undefined) data.enabled = body.enabled;

    const updated = await prisma.provider.update({ where: { id }, data });
    res.json(updated);
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: `Provider name "${req.body.name}" already exists` });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/providers/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.provider.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Provider not found' });
    if (existing.isEnv) return res.status(403).json({ error: 'Cannot delete env provider' });

    await prisma.provider.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 统计 ---

router.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const providers = await prisma.provider.findMany();
    const stats = aggregateAllStats(providers);
    res.json(stats);
  } catch (err) {
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