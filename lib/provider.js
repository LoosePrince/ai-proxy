const prisma = require('./prisma');

// round-robin 计数器（按 providerId）
const rrCounters = new Map();

function getRRIndex(providerId) {
  const idx = rrCounters.get(providerId) || 0;
  rrCounters.set(providerId, idx + 1);
  return idx;
}

/**
 * 获取所有启用的 providers，按 priority 排序
 */
async function getEnabledProviders() {
  return prisma.provider.findMany({
    where: { enabled: true },
    orderBy: { priority: 'asc' },
  });
}

/**
 * 根据请求模型和路由规则选出 provider 尝试顺序
 * @param {string|null} requestedModel - 客户端请求的模型名（可为空）
 * @returns {Provider[]} 有序的 provider 列表，依次尝试
 */
async function resolveProviders(requestedModel) {
  const all = await getEnabledProviders();
  if (all.length === 0) return [];

  let candidates;

  if (requestedModel) {
    // 筛选支持该模型的 providers
    const matched = all.filter((p) => {
      const models = Array.isArray(p.models) ? p.models : [];
      return models.includes(requestedModel);
    });
    candidates = matched.length > 0 ? matched : all;
  } else {
    candidates = all;
  }

  // 按 priority 升序排好后，根据 rule 决定最终顺序
  // 大部分场景下 candidates 已经按 priority 排序
  // 对于 balanced，同 priority 组内做 round-robin
  const groups = new Map();
  for (const p of candidates) {
    const key = p.priority;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const sortedPriorities = [...groups.keys()].sort((a, b) => a - b);
  const result = [];

  for (const pri of sortedPriorities) {
    const group = groups.get(pri);
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    // 检查组内 providers 的 rule 偏好
    // 取第一个 provider 的 rule 作为该组的路由规则
    const rule = group[0].rule || 'priority';

    if (rule === 'balanced') {
      // round-robin: 将偏移量后的 provider 放到前面
      // 用组内第一个 provider 的 id 作为 rr key
      const rrKey = group.map((g) => g.id).join(',');
      const offset = getRRIndex(rrKey) % group.length;
      const rotated = [...group.slice(offset), ...group.slice(0, offset)];
      result.push(...rotated);
    } else {
      // single / priority: 保持 priority 排序（即原顺序）
      result.push(...group);
    }
  }

  return result;
}

/**
 * 同步环境变量 FALLBACK_PROVIDERS 到数据库
 */
async function syncEnvProviders(envJson, retries = 3) {
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

        await prisma.provider.upsert({
          where: { name: p.name },
          update: {
            baseUrl: p.baseUrl,
            apiKey: p.apiKey,
            models: p.models || [],
            rule: p.rule || 'priority',
            priority: p.priority ?? 0,
            isEnv: true,
            enabled: true,
          },
          create: {
            name: p.name,
            baseUrl: p.baseUrl,
            apiKey: p.apiKey,
            models: p.models || [],
            rule: p.rule || 'priority',
            priority: p.priority ?? 0,
            isEnv: true,
            enabled: true,
            stats: {},
          },
        });
      }

      // env 中不再存在的 isEnv provider 降为普通 provider
      const envProviders = await prisma.provider.findMany({ where: { isEnv: true } });
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

module.exports = { getEnabledProviders, resolveProviders, syncEnvProviders };