/**
 * 端点健康（后台「状态监控」页）单测。
 *
 * 两层：
 *   1. classifyHealth 是纯函数，直接断言阈值边界；
 *   2. getEndpointHealth 的折叠逻辑（逐日补零、7/15/30 天窗口、零流量对象、
 *      状态优先排序）用一个只读替身库验证 —— 这里没有真实 SQL，因此不会
 *      把「SQL 写错了」当成通过，SQL 的正确性由迁移与写入侧的测试覆盖。
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { setDb, type LsqliteClient } from '../src/db/lsqlite';
import { classifyHealth, getEndpointHealth } from '../src/db/repo/endpoint-health';

function dayOffset(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** 只读替身：按 SQL 片段匹配结果集，未预期的查询直接抛错，避免测试静默跑偏 */
function installFakeDb(handlers: Array<{ match: string; rows: unknown[] }>): void {
  const client = {
    async select(sql: string): Promise<unknown[]> {
      const handler = handlers.find((item) => sql.includes(item.match));
      assert.ok(handler, `未预期的查询：${sql}`);
      return handler.rows;
    },
  } as unknown as LsqliteClient;

  setDb(client);
}

interface DayRowOptions {
  providerId?: number;
  label: string;
  day: string;
  attempts: number;
  success: number;
  failed: number;
  claimed?: number;
  durationSum?: number;
  durationCount?: number;
  ttfbMin?: number | null;
  lastSeenAt?: string | null;
}

function dayRow(options: DayRowOptions): Record<string, unknown> {
  return {
    label: options.label,
    provider_id: options.providerId ?? 0,
    day: options.day,
    attempts: options.attempts,
    success: options.success,
    failed: options.failed,
    claimed: options.claimed ?? 0,
    duration_sum_ms: options.durationSum ?? 0,
    duration_count: options.durationCount ?? 0,
    ttfb_min_ms: options.ttfbMin ?? null,
    last_seen_at: options.lastSeenAt ?? null,
  };
}

describe('classifyHealth', () => {
  it('阈值边界：≥95% 正常、≥80% 降级、其余异常', () => {
    assert.equal(classifyHealth(95, 5), 'ok');
    assert.equal(classifyHealth(19, 1), 'ok');
    assert.equal(classifyHealth(17, 3), 'degraded');
    assert.equal(classifyHealth(4, 1), 'degraded'); // 正好 80%
    assert.equal(classifyHealth(79, 21), 'down');
    assert.equal(classifyHealth(0, 1), 'down');
  });

  it('没有上游尝试时是「无流量」而不是「异常」', () => {
    // 低频部署里绝大多数渠道当天可能没有任何请求，标成故障会让整页变红
    assert.equal(classifyHealth(0, 0), 'idle');
  });

  it('竞速落败不进分母：只由传入的 success / failed 决定', () => {
    // claimed 由调用方在聚合阶段剔除，因此这里传进来的两个数字本身就决定了状态
    assert.equal(classifyHealth(10, 0), 'ok');
  });
});

describe('getEndpointHealth', () => {
  const today = dayOffset(0);
  const yesterday = dayOffset(1);

  it('按 7 / 15 / 30 天窗口切可用率，并补齐缺失日期', async () => {
    installFakeDb([
      {
        match: 'group by provider_id',
        rows: [
          // 渠道 1：最近 7 天 9 成功 / 1 失败，正好落在降级区
          dayRow({
            providerId: 1,
            label: 'p1',
            day: yesterday,
            attempts: 10,
            success: 9,
            failed: 1,
            claimed: 2,
            durationSum: 9_000,
            durationCount: 9,
            ttfbMin: 120,
            lastSeenAt: `${yesterday}T12:00:00.000Z`,
          }),
          // 15 天前的一条旧数据：只影响 15 / 30 天窗口
          dayRow({
            providerId: 1,
            label: 'p1',
            day: dayOffset(14),
            attempts: 3,
            success: 3,
            failed: 0,
            durationSum: 600,
            durationCount: 3,
            ttfbMin: 200,
            lastSeenAt: `${dayOffset(14)}T12:00:00.000Z`,
          }),
        ],
      },
      {
        match: 'from providers',
        rows: [
          { id: 1, name: 'p1', kind: 'primary', enabled: 1 },
          { id: 2, name: 'p2', kind: 'fallback', enabled: 1 },
        ],
      },
      { match: 'group by model, day', rows: [] },
      { match: 'from model_usage_daily', rows: [] },
    ]);

    const data = await getEndpointHealth();
    assert.equal(data.windowDays, 30);

    const channel = data.channels.find((row) => row.providerId === 1);
    assert.ok(channel);
    // 10 条尝试里 9 成功 -> 90%
    assert.equal(channel.availability7d, 90);
    // 7 天平均延迟只取成功尝试：9000ms / 9 次
    assert.equal(channel.avgLatency7d, 1_000);
    // 最近有流量的那天：昨天的平均耗时
    assert.equal(channel.latestLatencyMs, 1_000);
    // PING 取窗口内成功请求首字节的最小值
    assert.equal(channel.pingMs, 120);
    assert.equal(channel.claimed7d, 2);
    assert.equal(channel.state, 'degraded');
    assert.equal(channel.samples.length, 30);

    // 15 天外的旧数据仍在 30 天窗口里，因此 30 天可用率是 12/13
    assert.equal(channel.availability30d, 92.3);

    // 缺失日期补成「无流量」占位，颜色条长度恒等于窗口长度
    const empty = channel.samples.find((sample) => sample.day === dayOffset(5));
    assert.deepEqual(empty, {
      day: dayOffset(5),
      attempts: 0,
      success: 0,
      failed: 0,
      state: 'idle',
      availability: null,
    });
  });

  it('零流量的渠道与只命中缓存的模型也会出现，标记为「无流量」', async () => {
    installFakeDb([
      { match: 'group by provider_id', rows: [] },
      { match: 'from providers', rows: [{ id: 2, name: 'p2', kind: 'fallback', enabled: 0 }] },
      { match: 'group by model, day', rows: [] },
      { match: 'from model_usage_daily', rows: [{ actual_model: 'cached-only', requests: 42 }] },
    ]);

    const data = await getEndpointHealth();

    assert.equal(data.channels.length, 1);
    assert.equal(data.channels[0]?.state, 'idle');
    assert.equal(data.channels[0]?.enabled, false);
    assert.equal(data.channels[0]?.availability7d, null);
    assert.equal(data.channels[0]?.samples.length, 30);

    assert.equal(data.models.length, 1);
    assert.equal(data.models[0]?.model, 'cached-only');
    assert.equal(data.models[0]?.state, 'idle');
    assert.equal(data.models[0]?.attempts30d, 0);
  });

  it('异常对象排在正常对象前面，便于先看坏的', async () => {
    installFakeDb([
      {
        match: 'group by provider_id',
        rows: [
          dayRow({ providerId: 1, label: 'healthy', day: today, attempts: 10, success: 10, failed: 0 }),
          dayRow({ providerId: 2, label: 'broken', day: today, attempts: 10, success: 1, failed: 9 }),
          dayRow({ providerId: 3, label: 'meh', day: today, attempts: 10, success: 9, failed: 1 }),
        ],
      },
      {
        match: 'from providers',
        rows: [
          { id: 1, name: 'healthy', kind: 'primary', enabled: 1 },
          { id: 2, name: 'broken', kind: 'primary', enabled: 1 },
          { id: 3, name: 'meh', kind: 'primary', enabled: 1 },
        ],
      },
      { match: 'group by model, day', rows: [] },
      { match: 'from model_usage_daily', rows: [] },
    ]);

    const data = await getEndpointHealth();
    assert.deepEqual(
      data.channels.map((row) => [row.name, row.state]),
      [
        ['broken', 'down'],
        ['meh', 'degraded'],
        ['healthy', 'ok'],
      ],
    );
  });
});
