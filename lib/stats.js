const prisma = require('./prisma');

const VIRTUAL_PROVIDER_NAME = '__global_route_controller__';
const MAX_LOGS = 200;
const recentLogs = [];

function addLog(entry) {
  recentLogs.push({
    timestamp: new Date().toISOString(),
    ...entry,
  });
  while (recentLogs.length > MAX_LOGS) recentLogs.shift();
}

function getLogs() {
  return [...recentLogs];
}

function ensurePath(obj, ...keys) {
  let current = obj;
  for (const key of keys) {
    if (current[key] == null) current[key] = {};
    current = current[key];
  }
  return current;
}

function isVirtualProvider(provider) {
  if (!provider) return false;
  if (provider.name === VIRTUAL_PROVIDER_NAME) return true;
  return Number(provider.priority) < 0;
}

async function updateStats(providerId, { requestedModel, actualModel, ip, promptTokens, completionTokens, success }) {
  try {
    const p = await prisma.provider.findUnique({ where: { id: providerId } });
    if (!p) return;

    const stats = p.stats || {};
    stats.totalRequests = (stats.totalRequests || 0) + 1;
    if (success) {
      stats.successRequests = (stats.successRequests || 0) + 1;
    } else {
      stats.failedRequests = (stats.failedRequests || 0) + 1;
    }

    const pt = promptTokens || 0;
    const ct = completionTokens || 0;
    stats.totalPromptTokens = (stats.totalPromptTokens || 0) + pt;
    stats.totalCompletionTokens = (stats.totalCompletionTokens || 0) + ct;
    stats.totalTokens = (stats.totalTokens || 0) + pt + ct;

    // 模型统计
    if (requestedModel) {
      stats.models = stats.models || {};
      const m = ensurePath(stats.models, requestedModel);
      m.requested = (m.requested || 0) + 1;
      m.promptTokens = (m.promptTokens || 0) + pt;
      m.completionTokens = (m.completionTokens || 0) + ct;

      if (actualModel && actualModel !== requestedModel) {
        m.actualResolved = m.actualResolved || {};
        m.actualResolved[actualModel] = (m.actualResolved[actualModel] || 0) + 1;
      }
    }

    // IP 统计
    if (ip) {
      stats.ips = stats.ips || {};
      const ipEntry = stats.ips[ip] || { requests: 0, tokens: 0 };
      ipEntry.requests += 1;
      ipEntry.tokens += pt + ct;
      stats.ips[ip] = ipEntry;
    }

    await prisma.provider.update({
      where: { id: providerId },
      data: { stats },
    });
  } catch (err) {
    console.error('[Stats] update failed:', err.message);
  }
}

function aggregateAllStats(providers) {
  const total = {
    totalRequests: 0,
    successRequests: 0,
    failedRequests: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    models: {},
    ips: {},
    providers: {},
  };

  for (const p of providers) {
    if (isVirtualProvider(p)) continue;

    const s = p.stats || {};
    total.totalRequests += s.totalRequests || 0;
    total.successRequests += s.successRequests || 0;
    total.failedRequests += s.failedRequests || 0;
    total.totalPromptTokens += s.totalPromptTokens || 0;
    total.totalCompletionTokens += s.totalCompletionTokens || 0;
    total.totalTokens += s.totalTokens || 0;

    total.providers[p.name] = {
      totalRequests: s.totalRequests || 0,
      successRequests: s.successRequests || 0,
      failedRequests: s.failedRequests || 0,
      totalTokens: s.totalTokens || 0,
    };

    if (s.models) {
      for (const [model, data] of Object.entries(s.models)) {
        if (!total.models[model]) {
          total.models[model] = { requested: 0, promptTokens: 0, completionTokens: 0, actualResolved: {} };
        }
        total.models[model].requested += data.requested || 0;
        total.models[model].promptTokens += data.promptTokens || 0;
        total.models[model].completionTokens += data.completionTokens || 0;
        if (data.actualResolved) {
          for (const [actual, count] of Object.entries(data.actualResolved)) {
            total.models[model].actualResolved[actual] = (total.models[model].actualResolved[actual] || 0) + count;
          }
        }
      }
    }

    if (s.ips) {
      for (const [ip, data] of Object.entries(s.ips)) {
        if (!total.ips[ip]) total.ips[ip] = { requests: 0, tokens: 0 };
        total.ips[ip].requests += data.requests || 0;
        total.ips[ip].tokens += data.tokens || 0;
      }
    }
  }

  return total;
}

module.exports = { addLog, getLogs, updateStats, aggregateAllStats };