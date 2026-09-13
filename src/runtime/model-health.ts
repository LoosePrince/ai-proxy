/**
 * 模型健康状态与冷却 —— 进程内内存模块（与 counters.ts 同一层）。
 *
 * 这里维护的是「当前时刻」的健康判断，驱动路由偏好与冷却：
 *   - 历史可用率（状态监控页展示）在 endpoint_health_daily 落库，与本模块无关；
 *   - 本模块的判定窗口很小（默认 30 分钟），随进程重启清零 —— 这是有意的：
 *     冷却/偏好只是路由启发，重启后让所有模型重新获得平权机会。
 *
 * 口径与落库一致：
 *   - 只有真正打到上游的失败才计数（claimed-by-other、客户端中断不算）；
 *   - 冷却/健康都只对「渠道声明模型」生效，key 是 `${providerId}\u0000${model}`。
 */

/** 健康判定窗口：窗口内的成败样本决定「异常 / 无流量」判断 */
export const HEALTH_WINDOW_MS = 30 * 60_000;

export interface ModelHealthSettings {
  modelCooldownFailureThreshold: number;
  modelCooldownMinutes: number;
}

interface ModelSamples {
  /** 窗口内的最近样本时间戳（ms）与成败 */
  samples: Array<{ atMs: number; ok: boolean }>;
  /** 最近一次失败时刻（ms），用于「无流量 → 异常」的探测恢复 */
  lastFailureAtMs: number | null;
  /** 连续失败计数（冷却用），成功清零 */
  consecutiveFailures: number;
}

/** 冷却中的模型：providerId+model -> 解禁时刻（ms） */
const cooldowns = new Map<string, number>();
const healthByModel = new Map<string, ModelSamples>();

/** 健康样本上界：单模型窗口内最多记住 64 条，防止内存膨胀 */
const MAX_SAMPLES_PER_MODEL = 64;
const MAX_TRACKED_MODELS = 20_000;

function keyOf(providerId: number, model: string): string {
  return `${providerId}\u0000${model}`;
}

function evictOldest<V>(map: Map<string, V>, targetSize: number): void {
  if (map.size <= targetSize) return;
  const excess = map.size - targetSize;
  let removed = 0;
  for (const key of map.keys()) {
    map.delete(key);
    removed += 1;
    if (removed >= excess) break;
  }
}

export interface ModelHealthStatus {
  state: 'ok' | 'down' | 'idle';
  /** 冷却剩余秒数；0 表示未冷却 */
  cooldownRemainingSec: number;
  consecutiveFailures: number;
}

/**
 * 当前健康态：
 *   down    窗口内有真实失败（最近一次失败距今不超过窗口）
 *   idle    窗口内没有任何样本（无流量）
 *   ok      窗口内有过成功且其后没有失败
 */
export function modelHealthStatus(
  providerId: number,
  model: string,
  settings: ModelHealthSettings,
  nowMs = Date.now(),
): ModelHealthStatus {
  const cooldownUntil = cooldowns.get(keyOf(providerId, model));
  const cooldownRemainingSec =
    cooldownUntil !== undefined && cooldownUntil > nowMs ? Math.ceil((cooldownUntil - nowMs) / 1000) : 0;
  if (cooldownUntil !== undefined && cooldownUntil <= nowMs) cooldowns.delete(keyOf(providerId, model));

  const entry = healthByModel.get(keyOf(providerId, model));
  if (!entry || entry.samples.length === 0) {
    return { state: 'idle', cooldownRemainingSec, consecutiveFailures: entry?.consecutiveFailures ?? 0 };
  }

  const recent = entry.samples.filter((sample) => nowMs - sample.atMs <= HEALTH_WINDOW_MS);
  if (recent.length === 0) {
    // 窗口滑空了：按「上次失败距今是否超过窗口」回到无流量
    return {
      state: 'idle',
      cooldownRemainingSec,
      consecutiveFailures: entry.consecutiveFailures,
    };
  }

  const hasFailure = recent.some((sample) => !sample.ok);
  return {
    state: hasFailure ? 'down' : 'ok',
    cooldownRemainingSec,
    consecutiveFailures: entry.consecutiveFailures,
  };
}

/** 该模型当前是否处于冷却期（路由时应跳过） */
export function isModelCoolingDown(providerId: number, model: string, nowMs = Date.now()): boolean {
  const until = cooldowns.get(keyOf(providerId, model));
  if (until === undefined) return false;
  if (until <= nowMs) {
    cooldowns.delete(keyOf(providerId, model));
    return false;
  }
  return true;
}

/** 记录一次真实上游尝试结果；命中冷却阈值时立即进入冷却 */
export function recordModelAttempt(
  providerId: number,
  model: string,
  ok: boolean,
  settings: ModelHealthSettings,
  nowMs = Date.now(),
): void {
  const key = keyOf(providerId, model);
  const entry =
    healthByModel.get(key) ?? { samples: [], lastFailureAtMs: null, consecutiveFailures: 0 };

  entry.samples.push({ atMs: nowMs, ok });
  if (entry.samples.length > MAX_SAMPLES_PER_MODEL) entry.samples.splice(0, entry.samples.length - MAX_SAMPLES_PER_MODEL);
  entry.lastFailureAtMs = ok ? entry.lastFailureAtMs : nowMs;
  entry.consecutiveFailures = ok ? 0 : entry.consecutiveFailures + 1;

  healthByModel.set(key, entry);
  evictOldest(healthByModel, MAX_TRACKED_MODELS);

  const threshold = settings.modelCooldownFailureThreshold;
  if (!ok && threshold > 0 && entry.consecutiveFailures >= threshold && settings.modelCooldownMinutes > 0) {
    cooldowns.set(key, nowMs + settings.modelCooldownMinutes * 60_000);
    // 冷却期间健康样本一并清空：解禁后回到「无流量」，获得重新探测的机会
    entry.samples = [];
    entry.consecutiveFailures = 0;
  }
}

/** 供测试隔离状态 */
export function resetModelHealth(): void {
  cooldowns.clear();
  healthByModel.clear();
}

/** 供后台运行时面板观测 */
export function modelHealthStats(): { coolingDown: number; tracked: number } {
  const nowMs = Date.now();
  let coolingDown = 0;
  for (const [key, until] of cooldowns) {
    if (until <= nowMs) cooldowns.delete(key);
    else coolingDown += 1;
  }
  return { coolingDown, tracked: healthByModel.size };
}
