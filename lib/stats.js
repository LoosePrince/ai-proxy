const prisma = require('./prisma');

const ROUTE_CONTROLLER_NAME = '__global_route_controller__';
const MODEL_STATS_PROVIDER_NAME = '__global_model_stats__';
const IP_STATS_PROVIDER_NAME = '__global_ip_stats__';
const GLOBAL_SUMMARY_PROVIDER_NAME = '__global_summary_stats__';
const SPECIAL_PROVIDER_KEYS = {
  fallback: '__special_fallback__',
  parallel: '__special_parallel__',
};
const SPECIAL_PROVIDER_LABELS = {
  fallback: '保底 Provider',
  parallel: '并行 Provider',
};
const MAX_LOGS = 200;
const recentLogs = [];
let legacyCleanupPromise = null;

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
  if (provider.name === GLOBAL_SUMMARY_PROVIDER_NAME) return 'global-summary';
  if (Number(provider.priority) < 0) return 'virtual';
  return 'real';
}

function sanitizeProviderStats(stats) {
  const next = { ...(stats || {}) };
  let changed = false;

  if (Object.prototype.hasOwnProperty.call(next, 'models')) {
    delete next.models;
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(next, 'ips')) {
    delete next.ips;
    changed = true;
  }

  return changed ? next : null;
}

function mergeGlobalSummaryStats(stats, { promptTokens, completionTokens, success }) {
  const pt = promptTokens || 0;
  const ct = completionTokens || 0;
  const next = { ...(stats || {}) };
  next.totalRequests = (next.totalRequests || 0) + 1;
  next.totalPromptTokens = (next.totalPromptTokens || 0) + pt;
  next.totalCompletionTokens = (next.totalCompletionTokens || 0) + ct;
  next.totalTokens = (next.totalTokens || 0) + pt + ct;

  if (success) {
    next.successRequests = (next.successRequests || 0) + 1;
  } else {
    next.failedRequests = (next.failedRequests || 0) + 1;
  }

  return next;
}

function mergeProviderSummaryStats(stats, { promptTokens, completionTokens, success }) {
  return mergeGlobalSummaryStats(stats, { promptTokens, completionTokens, success });
}

function getSpecialProviderStatsKey(provider) {
  if (!provider?.isSpecialProvider || !provider.specialRole) return null;
  return SPECIAL_PROVIDER_KEYS[provider.specialRole] || `__special_${provider.specialRole}__`;
}

function getSpecialProviderDisplayName(provider) {
  const label = SPECIAL_PROVIDER_LABELS[provider.specialRole] || '特殊 Provider';
  return provider.name ? `${label} · ${provider.name}` : label;
}

function createSpecialProviderStatsEntry(provider, stats = {}) {
  return {
    name: getSpecialProviderDisplayName(provider),
    role: provider.specialRole,
    routeScope: 'special',
    isSpecialProvider: true,
    enabled: !!provider.enabled,
    totalRequests: stats.totalRequests || 0,
    successRequests: stats.successRequests || 0,
    failedRequests: stats.failedRequests || 0,
    totalPromptTokens: stats.totalPromptTokens || 0,
    totalCompletionTokens: stats.totalCompletionTokens || 0,
    totalTokens: stats.totalTokens || 0,
  };
}

function normalizeSpecialProviderStats(stats = {}) {
  const next = {};
  for (const [key, entry] of Object.entries(stats || {})) {
    next[key] = {
      ...entry,
      totalRequests: entry.totalRequests || 0,
      successRequests: entry.successRequests || 0,
      failedRequests: entry.failedRequests || 0,
      totalPromptTokens: entry.totalPromptTokens || 0,
      totalCompletionTokens: entry.totalCompletionTokens || 0,
      totalTokens: entry.totalTokens || 0,
    };
  }
  return next;
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
    {
      name: GLOBAL_SUMMARY_PROVIDER_NAME,
      priority: -4,
      baseUrl: 'https://stats-summary.invalid/v1',
      apiKey: '__stats_summary__',
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

  if (!legacyCleanupPromise) {
    legacyCleanupPromise = cleanupLegacyDetailStats().catch((error) => {
      console.error('[Stats] legacy cleanup failed:', error.message);
    });
  }
  await legacyCleanupPromise;

  return providers;
}

async function cleanupLegacyDetailStats() {
  const providers = await prisma.provider.findMany({
    where: { priority: { gte: 0 } },
    select: { id: true, stats: true },
  });

  const operations = [];
  for (const provider of providers) {
    const nextStats = sanitizeProviderStats(provider.stats);
    if (!nextStats) continue;
    operations.push(prisma.provider.update({
      where: { id: provider.id },
      data: { stats: nextStats },
    }));
  }

  if (operations.length) {
    await Promise.all(operations);
  }
}

async function updateStats(providerIdOrProvider, { requestedModel, actualModel, ip, promptTokens, completionTokens, success }) {
  try {
    const specialProvider = typeof providerIdOrProvider === 'object' && providerIdOrProvider?.isSpecialProvider
      ? providerIdOrProvider
      : null;
    const providerId = specialProvider ? null : providerIdOrProvider;
    const [provider, statsProviders] = await Promise.all([
      specialProvider
        ? Promise.resolve(null)
        : prisma.provider.findUnique({ where: { id: providerId } }),
      ensureStatsProviders(),
    ]);
    if (!provider && !specialProvider) return;

    const providerStats = provider?.stats || {};
    const nextProviderStats = specialProvider
      ? createSpecialProviderStatsEntry(
        specialProvider,
        mergeProviderSummaryStats({}, { promptTokens, completionTokens, success }),
      )
      : mergeProviderSummaryStats(providerStats, { promptTokens, completionTokens, success });

    const pt = promptTokens || 0;
    const ct = completionTokens || 0;

    const modelStatsProvider = statsProviders[MODEL_STATS_PROVIDER_NAME];
    const ipStatsProvider = statsProviders[IP_STATS_PROVIDER_NAME];
    const globalSummaryProvider = statsProviders[GLOBAL_SUMMARY_PROVIDER_NAME];
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
    const nextGlobalSummaryStats = mergeGlobalSummaryStats(globalSummaryProvider?.stats, {
      promptTokens: pt,
      completionTokens: ct,
      success,
    });

    const operations = [];

    if (specialProvider) {
      const routeController = await prisma.provider.findUnique({
        where: { name: ROUTE_CONTROLLER_NAME },
        select: { id: true, stats: true },
      });
      if (routeController) {
        const controllerStats = routeController.stats || {};
        const key = getSpecialProviderStatsKey(specialProvider);
        const specialProviderStats = normalizeSpecialProviderStats(controllerStats.specialProviders || {});
        specialProviderStats[key] = createSpecialProviderStatsEntry(
          specialProvider,
          mergeProviderSummaryStats(specialProviderStats[key], { promptTokens: pt, completionTokens: ct, success }),
        );
        operations.push(prisma.provider.update({
          where: { id: routeController.id },
          data: {
            stats: {
              ...controllerStats,
              specialProviders: specialProviderStats,
            },
          },
        }));
      }
    } else {
      operations.push(prisma.provider.update({
        where: { id: providerId },
        data: { stats: nextProviderStats },
      }));
    }

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

    if (globalSummaryProvider) {
      operations.push(prisma.provider.update({
        where: { id: globalSummaryProvider.id },
        data: { stats: nextGlobalSummaryStats },
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
  const globalSummaryProvider = providers.find((provider) => getVirtualProviderType(provider) === 'global-summary');

  if (globalSummaryProvider?.stats) {
    const stats = globalSummaryProvider.stats;
    total.totalRequests = stats.totalRequests || 0;
    total.successRequests = stats.successRequests || 0;
    total.failedRequests = stats.failedRequests || 0;
    total.totalPromptTokens = stats.totalPromptTokens || 0;
    total.totalCompletionTokens = stats.totalCompletionTokens || 0;
    total.totalTokens = stats.totalTokens || 0;
  } else {
    for (const p of providers) {
      if (getVirtualProviderType(p) !== 'real') continue;

      const s = p.stats || {};
      total.totalRequests += s.totalRequests || 0;
      total.successRequests += s.successRequests || 0;
      total.failedRequests += s.failedRequests || 0;
      total.totalPromptTokens += s.totalPromptTokens || 0;
      total.totalCompletionTokens += s.totalCompletionTokens || 0;
      total.totalTokens += s.totalTokens || 0;
    }
  }

  for (const p of providers) {
    if (getVirtualProviderType(p) !== 'real') continue;

    const s = p.stats || {};
    total.providers[p.name] = {
      name: p.name,
      routeScope: 'internal',
      isSpecialProvider: false,
      enabled: !!p.enabled,
      totalRequests: s.totalRequests || 0,
      successRequests: s.successRequests || 0,
      failedRequests: s.failedRequests || 0,
      totalTokens: s.totalTokens || 0,
    };
  }

  const routeController = providers.find((provider) => getVirtualProviderType(provider) === 'route-controller');
  const specialProviderStats = normalizeSpecialProviderStats(routeController?.stats?.specialProviders || {});
  const modelConfig = routeController?.stats?.modelConfig || {};
  const configuredSpecialProviders = [
    ['fallback', modelConfig.fallbackProvider || {}],
    ['parallel', modelConfig.parallelProvider || {}],
  ];
  const includedSpecialKeys = new Set();

  for (const [role, config] of configuredSpecialProviders) {
    const key = SPECIAL_PROVIDER_KEYS[role];
    const stored = specialProviderStats[key] || {};
    if (!config.enabled && !stored.totalRequests) continue;

    const entry = createSpecialProviderStatsEntry(
      {
        specialRole: role,
        name: config.name || '',
        enabled: !!config.enabled,
      },
      stored,
    );
    total.providers[entry.name] = entry;
    includedSpecialKeys.add(key);
  }

  for (const [key, s] of Object.entries(specialProviderStats)) {
    if (includedSpecialKeys.has(key)) continue;
    total.providers[s.name || key] = {
      ...s,
      name: s.name || key,
      routeScope: 'special',
      isSpecialProvider: true,
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