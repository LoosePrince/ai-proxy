const prisma = require('./prisma');

const rrCounters = new Map();

const GLOBAL_CONTROLLER_NAME = '__global_route_controller__';
const GLOBAL_CONTROLLER_PRIORITY = -1;
const GLOBAL_CONTROLLER_BASE_URL = 'https://controller.invalid/v1';
const GLOBAL_CONTROLLER_API_KEY = '__controller__';

function getRRIndex(key) {
  const idx = rrCounters.get(key) || 0;
  rrCounters.set(key, idx + 1);
  return idx;
}

function normalizeRoutingRule(rule) {
  if (rule === 'random') return 'random';
  if (rule === 'average' || rule === 'balanced') return 'average';
  return 'priority';
}

function isMissingContributionColumn(error) {
  return error.code === 'P2022' || /isContributed/i.test(error.message || '');
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

async function ensureProviderSchema() {
  try {
    await prisma.$executeRawUnsafe('ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "isContributed" BOOLEAN NOT NULL DEFAULT false');
    return true;
  } catch (error) {
    console.warn(`[Provider] schema check skipped: ${error.message}`);
    return false;
  }
}

function withoutContributionField(data) {
  const { isContributed, ...rest } = data;
  return rest;
}

async function upsertProviderCompat(args) {
  try {
    return await prisma.provider.upsert(args);
  } catch (error) {
    if (!isMissingContributionColumn(error)) throw error;
    return prisma.provider.upsert({
      ...args,
      update: withoutContributionField(args.update),
      create: withoutContributionField(args.create),
    });
  }
}

async function ensureGlobalRouteController() {
  const existing = await prisma.provider.findUnique({
    where: { name: GLOBAL_CONTROLLER_NAME },
    select: { id: true },
  }).catch((error) => {
    if (!isMissingContributionColumn(error)) throw error;
    return null;
  });

  if (existing) return existing;

  const controller = {
    name: GLOBAL_CONTROLLER_NAME,
    baseUrl: GLOBAL_CONTROLLER_BASE_URL,
    apiKey: GLOBAL_CONTROLLER_API_KEY,
    models: [],
    rule: 'priority',
    priority: GLOBAL_CONTROLLER_PRIORITY,
    enabled: true,
    isEnv: false,
    isContributed: false,
    stats: {},
  };

  return upsertProviderCompat({
    where: { name: GLOBAL_CONTROLLER_NAME },
    update: {},
    create: controller,
  });
}

function shuffleProviders(providers) {
  const result = [...providers];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function rotateItems(items, key) {
  if (items.length <= 1) return items;
  const offset = getRRIndex(key) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

function applyRoutingRule(items, rule, key) {
  if (rule === 'random') return shuffleProviders(items);
  if (rule === 'average') return rotateItems(items, key);
  return items;
}

function isGlobalRouteController(provider) {
  return provider && (provider.name === GLOBAL_CONTROLLER_NAME || Number(provider.priority) === GLOBAL_CONTROLLER_PRIORITY);
}

function selectCandidateProviders(providers, requestedModel) {
  const realProviders = providers.filter((provider) => !isGlobalRouteController(provider));
  if (!requestedModel) return realProviders;

  const matched = realProviders.filter((provider) => {
    const models = Array.isArray(provider.models) ? provider.models : [];
    return models.includes(requestedModel);
  });

  return matched.length > 0 ? matched : realProviders;
}

function groupProvidersByPriority(providers) {
  const groups = new Map();
  for (const provider of providers) {
    const priority = Number(provider.priority) || 0;
    if (!groups.has(priority)) groups.set(priority, []);
    groups.get(priority).push(provider);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([priority, items]) => ({
      priority,
      providers: items.sort((a, b) => a.id - b.id),
    }));
}

function getInternalRoutingRule(group) {
  return normalizeRoutingRule(group.providers[0]?.rule);
}

function createGroupRouteKey(groups) {
  return groups.map((group) => `${group.priority}:${group.providers.map((provider) => provider.id).join(',')}`).join('|');
}

function describeResolvedRouting(groups, globalRule) {
  return {
    globalRule,
    groupCount: groups.length,
    groups: groups.map((group) => ({
      priority: group.priority,
      internalRule: getInternalRoutingRule(group),
      providerIds: group.providers.map((provider) => provider.id),
      providerNames: group.providers.map((provider) => provider.name),
    })),
  };
}

async function getEnabledProviders() {
  await ensureGlobalRouteController();
  return prisma.provider.findMany({
    where: { enabled: true },
    orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    select: providerSelectWithoutContribution,
  });
}

async function getGlobalRoutingRule() {
  await ensureGlobalRouteController();
  const controller = await prisma.provider.findFirst({
    where: { enabled: true, priority: GLOBAL_CONTROLLER_PRIORITY },
    orderBy: { id: 'asc' },
    select: { rule: true },
  });
  return normalizeRoutingRule(controller?.rule);
}

async function resolveProviders(requestedModel) {
  const all = await getEnabledProviders();
  if (all.length === 0) return [];

  const candidates = selectCandidateProviders(all, requestedModel);
  if (candidates.length === 0) return [];

  const globalRule = await getGlobalRoutingRule();
  const groups = groupProvidersByPriority(candidates);
  const orderedGroups = applyRoutingRule(groups, globalRule, `global:${createGroupRouteKey(groups)}`);

  return orderedGroups.flatMap((group) => {
    const internalRule = getInternalRoutingRule(group);
    const key = `internal:${group.priority}:${group.providers.map((provider) => provider.id).join(',')}`;
    return applyRoutingRule(group.providers, internalRule, key);
  });
}

async function explainResolvedRouting(requestedModel) {
  const all = await getEnabledProviders();
  const candidates = selectCandidateProviders(all, requestedModel);
  const globalRule = await getGlobalRoutingRule();
  const groups = groupProvidersByPriority(candidates);
  const orderedGroups = applyRoutingRule(groups, globalRule, `global:${createGroupRouteKey(groups)}`);

  return {
    requestedModel: requestedModel || null,
    candidateCount: candidates.length,
    controllerCount: all.filter((provider) => isGlobalRouteController(provider)).length,
    routing: describeResolvedRouting(orderedGroups, globalRule),
  };
}

async function syncEnvProviders(envJson, retries = 3) {
  await ensureProviderSchema();
  await ensureGlobalRouteController();

  if (!envJson) return;

  let providers;
  try {
    providers = JSON.parse(envJson);
  } catch (e) {
    console.error('[Provider] FALLBACK_PROVIDERS JSON parse failed:', e.message);
    return;
  }

  if (!Array.isArray(providers)) {
    console.error('[Provider] FALLBACK_PROVIDERS must be an array');
    return;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const envNames = new Set();

      for (const p of providers) {
        if (!p.name || !p.baseUrl || !p.apiKey) {
          console.warn('[Provider] skipping invalid env provider (missing name/baseUrl/apiKey):', p.name);
          continue;
        }

        envNames.add(p.name);

        await upsertProviderCompat({
          where: { name: p.name },
          update: {
            baseUrl: p.baseUrl,
            apiKey: p.apiKey,
            models: p.models || [],
            rule: normalizeRoutingRule(p.rule),
            priority: p.priority ?? 0,
            isEnv: true,
            isContributed: false,
          },
          create: {
            name: p.name,
            baseUrl: p.baseUrl,
            apiKey: p.apiKey,
            models: p.models || [],
            rule: normalizeRoutingRule(p.rule),
            priority: p.priority ?? 0,
            isEnv: true,
            isContributed: false,
            enabled: true,
            stats: {},
          },
        });
      }

      const envProviders = await prisma.provider.findMany({
        where: { isEnv: true },
        select: { id: true, name: true },
      });
      for (const ep of envProviders) {
        if (!envNames.has(ep.name)) {
          await prisma.provider.update({
            where: { id: ep.id },
            data: { isEnv: false },
          });
          console.log(`[Provider] "${ep.name}" removed from env, downgraded to managed provider`);
        }
      }

      console.log('[Provider] env providers synced successfully');
      return;
    } catch (err) {
      console.warn(`[Provider] sync attempt ${attempt}/${retries} failed: ${err.message}`);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, attempt * 2000));
      }
    }
  }
  console.error('[Provider] failed to sync env providers after all retries');
}

module.exports = {
  ensureGlobalRouteController,
  ensureProviderSchema,
  explainResolvedRouting,
  getEnabledProviders,
  getGlobalRoutingRule,
  isMissingContributionColumn,
  normalizeRoutingRule,
  resolveProviders,
  syncEnvProviders,
};