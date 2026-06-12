const WINDOW_MS = 60_000;
const requestBuckets = new Map();

function normalizeIpRateLimitRpm(value, fallback = 20) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (number <= 0) return 0;
  return Math.round(number);
}

function checkIpRateLimit(ip, limitRpm) {
  const limit = normalizeIpRateLimitRpm(limitRpm, 20);
  if (limit === 0) {
    return { allowed: true, limit: 0, remaining: null, retryAfterSec: 0 };
  }

  const key = String(ip || 'unknown');
  const now = Date.now();
  const recent = (requestBuckets.get(key) || []).filter((timestamp) => now - timestamp < WINDOW_MS);

  if (recent.length >= limit) {
    const retryAfterMs = WINDOW_MS - (now - recent[0]);
    return {
      allowed: false,
      limit,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    };
  }

  recent.push(now);
  requestBuckets.set(key, recent);

  return {
    allowed: true,
    limit,
    remaining: limit - recent.length,
    retryAfterSec: 0,
  };
}

module.exports = {
  checkIpRateLimit,
  normalizeIpRateLimitRpm,
};
