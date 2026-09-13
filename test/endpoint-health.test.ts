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
import { classifyHealth, getChannelModelHealth, getEndpointHealth } from '../src/db/repo/endpoint-health';
import {
  HEALTH_WINDOW_MS,
  byHealthPreference,
  isModelCoolingDown,
  modelHealthStatus,
  recordModelAttempt,
  resetModelHealth,
} from '../src/runtime/model-health';
import { buildModelCandidates, byHealthPreference, type RotationCursor } from '../src/core/routing';
import type { ProviderRecord } from '../src/db/repo/providers';

function dayOffset(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** 只读替身：按 SQL 片段匹配结果集，未预期的查询直接抛错，避免测试静默跑偏 */
function installFakeDb(
  handlers: Array<{ match: string; rows: unknown[] }>,
  providers: Array<{ id: number; name: string }> = [],
): void {
  const client = {
    async select(sql: string): Promise<unknown[]> {
      const handler = handlers.find((item) => sql.includes(item.match));
      assert.ok(handler, `未预期的查询：${sql}`);
      return handler.rows;
    },
    async selectOne(sql: string, params: unknown[] = []): Promise<unknown | null> {
      if (sql.includes('from providers where id')) {
        return providers.find((row) => row.id === Number(params[0])) ?? null;
      }
      return null;
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
  it('阈值边界：≥95% 正常、≥85% 延迟、≥60% 降级、≥30% 异常、<30% 不可用', () => {
    assert.equal(classifyHealth(95, 5), 'ok');
    assert.equal(classifyHealth(19, 1), 'ok');
    // 85% 边界：延迟
    assert.equal(classifyHealth(17, 3), 'slow');
    assert.equal(classifyHealth(86, 14), 'slow');
    // 60% 边界：降级（84% 不足 85% 阈值，落入降级区）
    assert.equal(classifyHealth(84, 16), 'degraded');
    assert.equal(classifyHealth(6, 4), 'degraded');
    assert.equal(classifyHealth(59, 41), 'error'); // 59% 不足 60% 阈值，跌入异常区
    // 30% 边界：异常（正好 30% 也算异常）
    assert.equal(classifyHealth(3, 7), 'error');
    assert.equal(classifyHealth(31, 69), 'error');
    // 30% 以下：不可用（29% 跌破阈值）
    assert.equal(classifyHealth(29, 71), 'down');
    assert.equal(classifyHealth(1, 9), 'down');
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
      { match: 'from provider_models order by sort_order', rows: [] },
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
    // 90% 落在 85%–95% 区间：延迟（slow）
    assert.equal(channel.state, 'slow');
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

  it('零流量的渠道与从未被打到的声明模型也会出现，标记为「无流量」', async () => {
    installFakeDb([
      { match: 'group by provider_id', rows: [] },
      { match: 'from providers', rows: [{ id: 2, name: 'p2', kind: 'fallback', enabled: 0 }] },
      { match: 'group by model, day', rows: [] },
      {
        match: 'from provider_models order by sort_order',
        rows: [{ provider_id: 2, model: 'declared-only', enabled: 1 }],
      },
    ]);

    const data = await getEndpointHealth();

    assert.equal(data.channels.length, 1);
    assert.equal(data.channels[0]?.state, 'idle');
    assert.equal(data.channels[0]?.enabled, false);
    assert.equal(data.channels[0]?.availability7d, null);
    assert.equal(data.channels[0]?.samples.length, 30);

    // 新口径：模型列表来自渠道声明；从未有过上游尝试的声明模型以「无流量」出现
    assert.equal(data.models.length, 1);
    assert.equal(data.models[0]?.model, 'declared-only');
    assert.equal(data.models[0]?.state, 'idle');
    assert.equal(data.models[0]?.attempts30d, 0);
    assert.equal(data.models[0]?.providerCount, 1);
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
      { match: 'from provider_models order by sort_order', rows: [] },
    ]);

    const data = await getEndpointHealth();
    assert.deepEqual(
      data.channels.map((row) => [row.name, row.state]),
      [
        ['broken', 'down'],
        ['meh', 'slow'],
        ['healthy', 'ok'],
      ],
    );
  });

  it('新口径：模型列表来自声明（provider_models），历史流量仍按 attempted_model 聚合', async () => {
    installFakeDb([
      {
        match: 'group by provider_id',
        rows: [
          dayRow({ providerId: 1, label: 'p1', day: today, attempts: 4, success: 3, failed: 1 }),
        ],
      },
      { match: 'from providers', rows: [{ id: 1, name: 'p1', kind: 'primary', enabled: 1 }] },
      {
        match: 'group by model, day',
        rows: [
          // 只有声明模型 m1 有流量；客户端自定义透传名不会出现在健康数据里
          dayRow({ providerId: 1, label: 'm1', day: today, attempts: 4, success: 3, failed: 1 }),
        ],
      },
      {
        match: 'from provider_models order by sort_order',
        rows: [
          { provider_id: 1, model: 'm1', enabled: 1 },
          { provider_id: 1, model: 'm2', enabled: 1 },
          { provider_id: 1, model: 'm3', enabled: 0 },
        ],
      },
    ]);

    const data = await getEndpointHealth();
    const names = data.models.map((row) => [row.model, row.state, row.disabled]);

    // 声明的三个模型全部出现（含停用的 m3），零流量显示「无流量」；75% -> 降级
    assert.ok(names.some((row) => row[0] === 'm1' && row[1] === 'degraded' && row[2] === false));
    assert.ok(names.some((row) => row[0] === 'm2' && row[1] === 'idle' && row[2] === false));
    assert.ok(names.some((row) => row[0] === 'm3' && row[1] === 'idle' && row[2] === true));
    assert.equal(data.models.length, 3);
  });

  it('渠道弹窗：按渠道声明模型拆分，停用模型带标记', async () => {
    installFakeDb(
      [
        {
          match: 'group by model, day',
          rows: [
            dayRow({ providerId: 7, label: 'm1', day: today, attempts: 10, success: 10, failed: 0 }),
          ],
        },
        {
          match: 'from provider_models where provider_id',
          rows: [
            { provider_id: 7, model: 'm1', enabled: 1 },
            { provider_id: 7, model: 'm2', enabled: 0 },
          ],
        },
      ],
      [{ id: 7, name: 'p7' }],
    );

    const data = await getChannelModelHealth(7);
    assert.ok(data);
    assert.equal(data.channelName, 'p7');
    assert.equal(data.models.length, 2);
    assert.equal(data.models[0]?.model, 'm1');
    assert.equal(data.models[0]?.state, 'ok');
    assert.equal(data.models[0]?.disabled, false);
    assert.equal(data.models[1]?.model, 'm2');
    assert.equal(data.models[1]?.state, 'idle');
    assert.equal(data.models[1]?.disabled, true);
  });
});

describe('model-health（内存健康态与冷却）', () => {
  const settings = { modelCooldownFailureThreshold: 3, modelCooldownMinutes: 10 };

  it('窗口内有失败即 down，只有成功是 ok，无样本是 idle', () => {
    resetModelHealth();
    const now = Date.now();

    assert.equal(modelHealthStatus(1, 'm', settings, now).state, 'idle');

    recordModelAttempt(1, 'm', true, settings, now - 60_000);
    assert.equal(modelHealthStatus(1, 'm', settings, now).state, 'ok');

    recordModelAttempt(1, 'm', false, settings, now - 30_000);
    assert.equal(modelHealthStatus(1, 'm', settings, now).state, 'down');
  });

  it('连续失败达到阈值触发冷却，冷却期间路由应跳过', () => {
    resetModelHealth();
    const now = Date.now();

    recordModelAttempt(2, 'm', false, settings, now - 2_000);
    recordModelAttempt(2, 'm', false, settings, now - 1_000);
    assert.equal(isModelCoolingDown(2, 'm', now), false);

    recordModelAttempt(2, 'm', false, settings, now);
    assert.equal(isModelCoolingDown(2, 'm', now), true);
    assert.ok(modelHealthStatus(2, 'm', settings, now).cooldownRemainingSec > 0);

    // 冷却阈值清零后：连续失败计数与样本一并重置，回到无流量
    assert.equal(modelHealthStatus(2, 'm', settings, now).consecutiveFailures, 0);
    assert.equal(modelHealthStatus(2, 'm', settings, now).state, 'idle');
  });

  it('成功清零连续失败计数；窗口滑空后回到无流量', () => {
    resetModelHealth();
    const now = Date.now();

    recordModelAttempt(3, 'm', false, settings, now - 3_000);
    recordModelAttempt(3, 'm', true, settings, now - 2_000);
    assert.equal(modelHealthStatus(3, 'm', settings, now).consecutiveFailures, 0);

    // 只留一个很久以前的样本：窗口外 -> idle
    resetModelHealth();
    recordModelAttempt(3, 'm', true, settings, now - HEALTH_WINDOW_MS - 1);
    assert.equal(modelHealthStatus(3, 'm', settings, now).state, 'idle');
  });

  it('byHealthPreference：异常在前、无流量次之、正常最后，且保持稳定排序', () => {
    const order = byHealthPreference(
      ['a', 'b', 'c', 'd'].map((name) => ({ name, state: (name === 'a' ? 'ok' : name === 'b' ? 'idle' : 'down') as 'ok' | 'idle' | 'down' })),
      (item) => item.state,
    );
    assert.deepEqual(
      order.map((item) => item.name),
      ['c', 'd', 'b', 'a'],
    );
  });
});

describe('buildModelCandidates 健康感知', () => {
  const cursor: RotationCursor = { next: () => 0 };

  function provider(models: string[]): ProviderRecord {
    return {
      id: 1,
      name: 'p',
      baseUrl: 'https://x',
      apiKey: 'k',
      systemPrompt: '',
      requestMode: 'openai',
      requestScript: '',
      variables: [],
      variablesAutoSync: false,
      mainScript: '',
      scheduleEnabled: false,
      scheduleCron: '',
      scheduleStatus: 'idle',
      lastRunAt: null,
      lastRunOk: null,
      lastRunError: null,
      variablesUpdatedAt: null,
      models,
      declaredModels: models,
      disabledModels: [],
      excludeFromModelMatching: false,
      modelMatchExcludeModels: [],
      kind: 'primary',
      source: 'managed',
      priority: 0,
      enabled: true,
      contributor: null,
      contributorType: null,
      createdAt: '',
      updatedAt: '',
    };
  }

  it('冷却中的模型被剔除；异常/无流量模型按 probe 模式前置', () => {
    const record = provider(['m1', 'm2', 'm3']);
    const healthOf = (model: string): { state: 'ok' | 'down' | 'idle'; coolingDown: boolean } => {
      if (model === 'm1') return { state: 'ok', coolingDown: false };
      if (model === 'm2') return { state: 'down', coolingDown: false };
      return { state: 'idle', coolingDown: true };
    };

    // random 模式：冷却剔除，但不重排
    const plain = buildModelCandidates(record, null, 'priority', cursor, 10, true, {
      mode: 'random',
      healthOf,
    });
    assert.deepEqual(plain, ['m1', 'm2']);

    // prefer-unhealthy：异常/无流量在前（m3 冷却已剔除，只剩 m2 在 m1 前）
    const prefer = buildModelCandidates(record, null, 'priority', cursor, 10, true, {
      mode: 'prefer-unhealthy',
      healthOf,
    });
    assert.deepEqual(prefer, ['m2', 'm1']);

    // probe-unhealthy-first 与 prefer 同序（首个尝试用于探测）
    const probe = buildModelCandidates(record, null, 'priority', cursor, 10, true, {
      mode: 'probe-unhealthy-first',
      healthOf,
    });
    assert.deepEqual(probe, ['m2', 'm1']);
  });

  it('渠道停用的模型（不在 models 列表）不会成为候选', () => {
    const record = provider(['m1']);
    const candidates = buildModelCandidates(record, null, 'priority', cursor, 10, true);
    assert.deepEqual(candidates, ['m1']);
  });
});
