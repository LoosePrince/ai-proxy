const prisma = require('./prisma');

const ROUTE_CONTROLLER_NAME = '__global_route_controller__';
const MODEL_STATS_PROVIDER_NAME = '__global_model_stats__';
const IP_STATS_PROVIDER_NAME = '__global_ip_stats__';
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

function getVirtualProviderType(provider) {
  if (!provider) return 'real';
  if (provider.name === ROUTE_CONTROLLER_NAME) return 'route-controller';
  if (provider.name === MODEL_STATS_PROVIDER_NAME) return 'model-stats';
  if (provider.name === IP_STATS_PROVIDER_NAME) return 'ip-stats';
  if (Number(provider.priority) < 0) return 'virtual';
  return 'real';
}

function mergeModelStats(stats, { requestedModel, actualModel, promptTokens, completionTokens }) {
  if (!requestedModel) return stats;

  const next = { ...(stats || {}) };
  next.models = next.models || {};
  const modelStats = ensurePath(next.models, requestedModel);
  modelStats.requested = (modelStats.requested || 0) + 1;
  modelStats.promptTokens = (modelStats.promptTokens || 0) + (promptTokens || 0);
  modelStats.completionTokens = (modelStats.completionTokens || 0) + (completionTokens || 0);

  if (actualModel && actualModel !== requestedModel) {
    modelStats.actualResolved = modelStats.actualResolved || {};
    modelStats.actualResolved[actualModel] = (modelStats.actualResolved[actualModel] || 0) + 1;
  }

  return next;
}

function mergeIpStats(stats, { ip, promptTokens, completionTokens }) {
  if (!ip) return stats;

  const next = { ...(stats || {}) };
  next.ips = next.ips || {};
  const ipEntry = next.ips[ip] || { requests: 0, tokens: 0 };
  ipEntry.requests += 1;
  ipEntry.tokens += (promptTokens || 0) + (completionTokens || 0);
  next.ips[ip] = ipEntry;
  return next;
}

async function ensureStatsProviders() {
  const definitions = [
    {
      name: MODEL_STATS_PROVIDER_NAME,
      priority: -2,
      baseUrl: 'https://stats-model.invalid/v1',
      apiKey: '__stats_model__',
    },
    {
      name: IP_STATS_PROVIDER_NAME,
      priority: -3,
      baseUrl: 'https://stats-ip.invalid/v1',
      apiKey: '__stats_ip__',
    },
  ];

  const providers = {};
  for (const definition of definitions) {
    providers[definition.name] = await prisma.provider.upsert({
      where: { name: definition.name },
      update: {
        priority: definition.priority,
        enabled: true,
      },
      create: {
        name: definition.name,
        baseUrl: definition.baseUrl,
        apiKey: definition.apiKey,
        models: [],
        rule: 'priority',
        priority: definition.priority,
        enabled: true,
        isEnv: false,
        isContributed: false,
        stats: {},
      },
      select: { id: true, name: true, stats: true },
    });
  }

  return providers;
}

async function updateStats(providerId, { requestedModel, actualModel, ip, promptTokens, completionTokens, success }) {
  try {
    const [provider, statsProviders] = await Promise.all([
      prisma.provider.findUnique({ where: { id: providerId } }),
      ensureStatsProviders(),
    ]);
    if (!provider) return;

    const stats = provider.stats || {};
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

    const modelStatsProvider = statsProviders[MODEL_STATS_PROVIDER_NAME];
    const ipStatsProvider = statsProviders[IP_STATS_PROVIDER_NAME];
    const nextModelStats = mergeModelStats(modelStatsProvider?.stats, {
      requestedModel,
      actualModel,
      promptTokens: pt,
      completionTokens: ct,
    });
    const nextIpStats = mergeIpStats(ipStatsProvider?.stats, {
      ip,
      promptTokens: pt,
      completionTokens: ct,
    });

    const operations = [
      prisma.provider.update({
        where: { id: providerId },
        data: { stats },
      }),
    ];

    if (modelStatsProvider) {
      operations.push(prisma.provider.update({
        where: { id: modelStatsProvider.id },
        data: { stats: nextModelStats },
      }));
    }

    if (ipStatsProvider) {
      operations.push(prisma.provider.update({
        where: { id: ipStatsProvider.id },
        data: { stats: nextIpStats },
      }));
    }

    await Promise.all(operations);
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

  const modelStatsProvider = providers.find((provider) => getVirtualProviderType(provider) === 'model-stats');
  const ipStatsProvider = providers.find((provider) => getVirtualProviderType(provider) === 'ip-stats');

  for (const p of providers) {
    if (getVirtualProviderType(p) !== 'real') continue;

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
  }

  const modelStats = modelStatsProvider?.stats?.models || {};
  for (const [model, data] of Object.entries(modelStats)) {
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

  const ipStats = ipStatsProvider?.stats?.ips || {};
  for (const [ip, data] of Object.entries(ipStats)) {
    if (!total.ips[ip]) total.ips[ip] = { requests: 0, tokens: 0 };
    total.ips[ip].requests += data.requests || 0;
    total.ips[ip].tokens += data.tokens || 0;
  }

  return total;
}

module.exports = {
  addLog,
  aggregateAllStats,
  ensureStatsProviders,
  getLogs,
  getVirtualProviderType,
  updateStats,
};