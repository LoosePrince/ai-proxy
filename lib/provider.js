const prisma = require('./prisma');

const rrCounters = new Map();

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

function shuffleProviders(providers) {
  const result = [...providers];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function rotateProviders(providers, key) {
  if (providers.length <= 1) return providers;
  const offset = getRRIndex(key) % providers.length;
  return [...providers.slice(offset), ...providers.slice(0, offset)];
}

async function getEnabledProviders() {
  return prisma.provider.findMany({
    where: { enabled: true },
    orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    select: providerSelectWithoutContribution,
  });
}

async function getGlobalRoutingRule() {
  const controller = await prisma.provider.findFirst({
    where: { priority: 0 },
    orderBy: { id: 'asc' },
    select: { rule: true },
  });
  return normalizeRoutingRule(controller?.rule);
}

async function resolveProviders(requestedModel) {
  const all = await getEnabledProviders();
  if (all.length === 0) return [];

  let candidates;
  if (requestedModel) {
    const matched = all.filter((p) => {
      const models = Array.isArray(p.models) ? p.models : [];
      return models.includes(requestedModel);
    });
    candidates = matched.length > 0 ? matched : all;
  } else {
    candidates = all;
  }

  const rule = await getGlobalRoutingRule();
  if (rule === 'random') return shuffleProviders(candidates);
  if (rule === 'average') {
    const key = candidates.map((provider) => provider.id).join(',');
    return rotateProviders(candidates, key);
  }
  return candidates;
}

async function syncEnvProviders(envJson, retries = 3) {
  await ensureProviderSchema();

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
  ensureProviderSchema,
  getEnabledProviders,
  getGlobalRoutingRule,
  isMissingContributionColumn,
  normalizeRoutingRule,
  resolveProviders,
  syncEnvProviders,
};