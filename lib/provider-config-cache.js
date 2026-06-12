const prisma = require('./prisma');

const GLOBAL_CONTROLLER_PRIORITY = -1;

const routingProviderSelect = {
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

let routingConfigCache = null;
let routingConfigPromise = null;

async function fetchRoutingConfigFromDb() {
  const [enabledProviders, globalController] = await Promise.all([
    prisma.provider.findMany({
      where: { enabled: true },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
      select: routingProviderSelect,
    }),
    prisma.provider.findFirst({
      where: { enabled: true, priority: GLOBAL_CONTROLLER_PRIORITY },
      orderBy: { id: 'asc' },
      select: { id: true, rule: true, stats: true },
    }),
  ]);

  return {
    enabledProviders,
    globalController: globalController || null,
  };
}

async function getRoutingConfig() {
  if (routingConfigCache) return routingConfigCache;

  if (!routingConfigPromise) {
    routingConfigPromise = fetchRoutingConfigFromDb()
      .then((config) => {
        routingConfigCache = config;
        routingConfigPromise = null;
        return config;
      })
      .catch((error) => {
        routingConfigPromise = null;
        throw error;
      });
  }

  return routingConfigPromise;
}

function invalidateProviderRoutingCache() {
  routingConfigCache = null;
  routingConfigPromise = null;
}

module.exports = {
  getRoutingConfig,
  invalidateProviderRoutingCache,
};
