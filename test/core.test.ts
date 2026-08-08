/**
 * core 层单测。
 *
 * core/* 全是纯函数，无 IO、无全局状态，因此可以直接断言，
 * 不需要数据库或 HTTP 替身。这些函数决定路由正确性，是回归的第一道防线。
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  applyRule,
  buildAttemptChain,
  buildModelCandidates,
  findSpecialProvider,
  groupByPriority,
  selectCandidates,
  type RotationCursor,
} from '../src/core/routing';
import { resolveTimeoutMs } from '../src/core/timeout';
import { createResponseGate, createRaceWindow } from '../src/core/gate';
import {
  createTrace,
  withAttempt,
  withFirstResponse,
  withFallbackTriggered,
  toRequestEvent,
} from '../src/core/trace';
import {
  contributionProviderName,
  contributorDisplayName,
  maskBaseUrl,
  normalizeContributor,
  normalizeModels,
} from '../src/core/contribution';
import { toContributionDTO } from '../src/http/dto';
import {
  normalizeChatPayload,
  responseInputToChatMessages,
} from '../src/core/protocol';
import type { PriorityGroupRecord, ProviderRecord } from '../src/db/repo/providers';
import type { SettingsDTO } from '../src/types/api';

/** 确定性游标，避免测试依赖随机或共享状态 */
function createCursor(): RotationCursor {
  const counts = new Map<string, number>();
  return {
    next(key: string) {
      const current = counts.get(key) ?? 0;
      counts.set(key, current + 1);
      return current;
    },
  };
}

function provider(overrides: Partial<ProviderRecord> & { id: number }): ProviderRecord {
  return {
    name: `p${overrides.id}`,
    baseUrl: 'https://upstream.invalid/v1',
    apiKey: 'sk-test',
    models: [],
    kind: 'primary',
    source: 'managed',
    priority: 0,
    enabled: true,
    contributor: null,
    contributorType: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function groups(entries: Array<[number, Partial<PriorityGroupRecord>]>): Map<number, PriorityGroupRecord> {
  return new Map(
    entries.map(([priority, config]) => [
      priority,
      { priority, rule: config.rule ?? 'priority', timeoutMs: config.timeoutMs ?? null },
    ]),
  );
}

describe('routing/selectCandidates', () => {
  const list = [
    provider({ id: 1, models: ['gpt-4o'] }),
    provider({ id: 2, models: ['claude-3'] }),
    provider({ id: 3, kind: 'fallback', models: ['gpt-4o'] }),
    provider({ id: 4, enabled: false, models: ['gpt-4o'] }),
  ];

  it('只保留启用的 primary provider', () => {
    assert.deepEqual(selectCandidates(list, null).map((p) => p.id), [1, 2]);
  });

  it('指定模型时只取支持该模型的 provider', () => {
    assert.deepEqual(selectCandidates(list, 'claude-3').map((p) => p.id), [2]);
  });

  it('指定模型支持大小写、分隔符与厂商前缀的近似匹配', () => {
    const fuzzy = [
      provider({ id: 10, models: ['openai/gpt-4o-mini'] }),
      provider({ id: 11, models: ['deepseek-ai/DeepSeek-R1'] }),
    ];

    assert.deepEqual(selectCandidates(fuzzy, 'GPT 4o mini').map((p) => p.id), [10]);
    assert.deepEqual(selectCandidates(fuzzy, 'deepseek-r1').map((p) => p.id), [11]);
  });

  it('没有相近模型时不尝试声明了其他模型的 primary provider', () => {
    assert.deepEqual(selectCandidates(list, 'unknown-model'), []);
  });
});

describe('routing/groupByPriority', () => {
  it('按 priority 升序分组，组内按 id 升序', () => {
    const result = groupByPriority(
      [provider({ id: 5, priority: 1 }), provider({ id: 2, priority: 0 }), provider({ id: 1, priority: 1 })],
      groups([[1, { rule: 'random' }]]),
    );

    assert.deepEqual(
      result.map((g) => [g.priority, g.providers.map((p) => p.id)]),
      [
        [0, [2]],
        [1, [1, 5]],
      ],
    );
  });

  it('组规则来自 priority_groups，而不是组内第一个 provider', () => {
    const result = groupByPriority([provider({ id: 1, priority: 2 })], groups([[2, { rule: 'average' }]]));
    assert.equal(result[0].rule, 'average');
  });

  it('未配置的组回落到 priority 规则', () => {
    const result = groupByPriority([provider({ id: 1, priority: 9 })], groups([]));
    assert.equal(result[0].rule, 'priority');
  });
});

describe('routing/applyRule', () => {
  it('priority 保持原序，且返回新数组不改动入参', () => {
    const input = [1, 2, 3];
    const output = applyRule(input, 'priority', 'k', createCursor());
    assert.deepEqual(output, [1, 2, 3]);
    assert.notEqual(output, input);
  });

  it('average 逐次轮转，实现负载均摊', () => {
    const cursor = createCursor();
    assert.deepEqual(applyRule([1, 2, 3], 'average', 'k', cursor), [1, 2, 3]);
    assert.deepEqual(applyRule([1, 2, 3], 'average', 'k', cursor), [2, 3, 1]);
    assert.deepEqual(applyRule([1, 2, 3], 'average', 'k', cursor), [3, 1, 2]);
    assert.deepEqual(applyRule([1, 2, 3], 'average', 'k', cursor), [1, 2, 3]);
  });

  it('random 保留全部元素，只改变顺序', () => {
    const output = applyRule([1, 2, 3, 4, 5], 'random', 'k', createCursor());
    assert.deepEqual([...output].sort(), [1, 2, 3, 4, 5]);
  });
});

describe('routing/buildAttemptChain', () => {
  const list = [
    provider({ id: 1, priority: 0, models: ['m1'] }),
    provider({ id: 2, priority: 0, models: ['m1'] }),
    provider({ id: 3, priority: 1, models: ['m1'] }),
  ];

  it('priority 规则下按组升序、组内 id 升序展开为扁平链', () => {
    assert.deepEqual(
      buildAttemptChain(list, groups([]), null, 'priority', createCursor()).map((p) => p.id),
      [1, 2, 3],
    );
  });

  it('组内 average 规则在组间顺序不变的前提下轮转', () => {
    const cursor = createCursor();
    const config = groups([[0, { rule: 'average' }]]);

    assert.deepEqual(buildAttemptChain(list, config, null, 'priority', cursor).map((p) => p.id), [1, 2, 3]);
    assert.deepEqual(buildAttemptChain(list, config, null, 'priority', cursor).map((p) => p.id), [2, 1, 3]);
  });

  it('全局 average 规则轮转组间顺序', () => {
    const cursor = createCursor();
    assert.deepEqual(buildAttemptChain(list, groups([]), null, 'average', cursor).map((p) => p.id), [1, 2, 3]);
    assert.deepEqual(buildAttemptChain(list, groups([]), null, 'average', cursor).map((p) => p.id), [3, 1, 2]);
  });

  it('无候选时返回空链', () => {
    assert.deepEqual(buildAttemptChain([], groups([]), null, 'priority', createCursor()), []);
  });
});

describe('routing/buildModelCandidates', () => {
  const p = provider({ id: 1, models: ['a', 'b', 'c', 'd'] });

  it('请求模型被支持时只尝试匹配模型', () => {
    assert.deepEqual(buildModelCandidates(p, 'c', 'priority', createCursor(), 3), ['c']);
  });

  it('按 maxCount 截断', () => {
    assert.deepEqual(buildModelCandidates(p, null, 'priority', createCursor(), 2), ['a', 'b']);
  });

  it('provider 未声明模型时透传请求模型', () => {
    const bare = provider({ id: 2, models: [] });
    assert.deepEqual(buildModelCandidates(bare, 'x', 'priority', createCursor(), 3), ['x']);
    assert.deepEqual(buildModelCandidates(bare, null, 'priority', createCursor(), 3), []);
  });

  it('近似请求模型映射到 provider 声明的真实模型', () => {
    const fuzzy = provider({ id: 4, models: ['openai/gpt-4o-mini', 'deepseek-chat'] });
    assert.deepEqual(buildModelCandidates(fuzzy, 'GPT 4o mini', 'priority', createCursor(), 2), [
      'openai/gpt-4o-mini',
    ]);
  });

  it('指定模型时 fallback 与 parallel 忽略自身模型列表并原样透传', () => {
    const fallback = provider({ id: 5, kind: 'fallback', models: ['fallback-default'] });
    const parallel = provider({ id: 6, kind: 'parallel', models: ['parallel-default'] });

    assert.deepEqual(buildModelCandidates(fallback, 'deepseek-reasoner', 'priority', createCursor(), 3), [
      'deepseek-reasoner',
    ]);
    assert.deepEqual(buildModelCandidates(parallel, 'deepseek-reasoner', 'priority', createCursor(), 3), [
      'deepseek-reasoner',
    ]);
  });

  it('去重并剔除空白模型名', () => {
    const dup = provider({ id: 3, models: ['a', 'a', ' ', 'b'] });
    assert.deepEqual(buildModelCandidates(dup, null, 'priority', createCursor(), 5), ['a', 'b']);
  });
});

describe('routing/findSpecialProvider', () => {
  it('按 kind 定位，不依赖负 id 或魔法 priority', () => {
    const list = [
      provider({ id: 1 }),
      provider({ id: 2, kind: 'fallback' }),
      provider({ id: 3, kind: 'parallel', enabled: false }),
    ];
    assert.equal(findSpecialProvider(list, 'fallback')?.id, 2);
    assert.equal(findSpecialProvider(list, 'parallel'), null);
  });
});

describe('timeout/resolveTimeoutMs', () => {
  const settings: SettingsDTO = {
    globalRule: 'priority',
    defaultResponseTimeoutMs: 30_000,
    fallbackResponseTimeoutMs: 45_000,
    parallelTimeoutMs: 14_000,
    ipRateLimitRpm: 20,
    maxPrimaryAttempts: 3,
    maxModelRetryCount: 3,
    logRetentionDays: 0,
  };

  it('fallback 与 parallel 使用各自的独立超时', () => {
    assert.equal(resolveTimeoutMs(provider({ id: 1, kind: 'fallback' }), settings, groups([])), 45_000);
    assert.equal(resolveTimeoutMs(provider({ id: 2, kind: 'parallel' }), settings, groups([])), 14_000);
  });

  it('组级 timeoutMs 覆盖默认超时', () => {
    assert.equal(
      resolveTimeoutMs(provider({ id: 3, priority: 1 }), settings, groups([[1, { timeoutMs: 8_000 }]])),
      8_000,
    );
  });

  it('组未配置超时时继承默认值', () => {
    assert.equal(resolveTimeoutMs(provider({ id: 4, priority: 7 }), settings, groups([])), 30_000);
  });
});

describe('gate', () => {
  it('只有第一个抢占者获得响应权', () => {
    const gate = createResponseGate();
    assert.equal(gate.claim('a'), true);
    assert.equal(gate.claim('b'), false);
    assert.equal(gate.isOwnedBy('a'), true);
    assert.equal(gate.isOwnedBy('b'), false);
  });

  it('抢占失败不会锁死闸门，后续者仍可获得响应权', () => {
    const gate = createResponseGate();
    assert.equal(gate.claim('late', () => false), false);
    assert.equal(gate.isClaimed(), false);
    assert.equal(gate.claim('primary'), true);
  });

  it('竞速窗口到期后拒绝抢占', () => {
    const expired = createRaceWindow(-1);
    assert.equal(createResponseGate().claim('parallel', expired), false);
  });
});

describe('trace', () => {
  const base = { requestedModel: 'm1', stream: true, ip: '1.2.3.4', nowMs: 1_000_000 };

  const failedAttempt = {
    role: 'primary' as const,
    providerId: 1,
    providerName: 'p1',
    priority: 0,
    attemptedModel: 'm1',
    timeoutMs: 30_000,
    status: 'failed' as const,
    errorMessage: 'boom',
    startedAtMs: base.nowMs,
    endedAtMs: base.nowMs + 12,
  };

  it('withAttempt 返回新对象，已产出的快照不会被追溯改写', () => {
    const t0 = createTrace(base);
    const t1 = withAttempt(t0, failedAttempt);

    assert.equal(t0.attempts.length, 0);
    assert.equal(t1.attempts.length, 1);
    assert.notEqual(t0, t1);
  });

  it('失败与 claimed-by-other 都会被记录，不再被静默丢弃', () => {
    const t = withAttempt(
      withAttempt(createTrace(base), failedAttempt),
      { ...failedAttempt, status: 'claimed-by-other' as const },
    );

    assert.deepEqual(t.attempts.map((a) => a.seq), [1, 2]);
    assert.deepEqual(t.attempts.map((a) => a.status), ['failed', 'claimed-by-other']);
  });

  it('失败的 attempt 不记录 actualModel', () => {
    const t = withAttempt(createTrace(base), { ...failedAttempt, actualModel: 'should-be-dropped' });
    assert.equal(t.attempts[0].actualModel, null);
    assert.equal(t.attempts[0].durationMs, 12);
  });

  it('withFirstResponse 只记录首次，重复调用不覆盖', () => {
    const t1 = withFirstResponse(createTrace(base), base.nowMs + 100);
    const t2 = withFirstResponse(t1, base.nowMs + 500);
    assert.equal(t1.firstResponseAtMs, base.nowMs + 100);
    assert.equal(t2.firstResponseAtMs, base.nowMs + 100);
  });

  it('toRequestEvent 产出可直接入队的事件并算出 TTFB', () => {
    const trace = withFallbackTriggered(withFirstResponse(createTrace(base), base.nowMs + 120));
    const event = toRequestEvent(
      trace,
      {
        success: true,
        httpStatus: 200,
        finalProviderId: 7,
        finalProviderName: 'p7',
        finalRole: 'fallback',
        finalModel: 'm1-real',
        promptTokens: 11,
        completionTokens: 22,
      },
      base.nowMs + 300,
    );

    assert.equal(event.success, true);
    assert.equal(event.ttfbMs, 120);
    assert.equal(event.totalMs, 300);
    assert.equal(event.promptTokens, 11);
    assert.equal(event.finalModel, 'm1-real');
    assert.equal(event.fallbackTriggered, true);
    assert.equal(event.stream, true);
    assert.equal(event.ip, '1.2.3.4');
  });

  it('trace id 互不重复', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createTrace(base).traceId));
    assert.equal(ids.size, 200);
  });
});

describe('contribution/normalizeContributor', () => {
  it('识别邮箱并为 QQ 邮箱推导头像', () => {
    const result = normalizeContributor('123456@qq.com');
    assert.equal(result.contributorType, 'email');
    assert.match(String(result.avatarUrl), /q\.qlogo\.cn/);
  });

  it('非 QQ 邮箱不推导头像', () => {
    assert.equal(normalizeContributor('dev@example.com').avatarUrl, null);
  });

  it('识别 GitHub 用户名', () => {
    assert.equal(normalizeContributor('Loose-Prince').contributorType, 'github');
  });

  it('拒绝非法标识', () => {
    assert.throws(() => normalizeContributor(''));
    assert.throws(() => normalizeContributor('bad name!'));
  });
});

describe('contribution/normalizeModels', () => {
  it('支持逗号与换行混合分隔，并去重', () => {
    assert.deepEqual(normalizeModels('a, b\nc,a'), ['a', 'b', 'c']);
  });

  it('空列表被拒绝', () => {
    assert.throws(() => normalizeModels('  '));
  });

  it('数量超上限时截断到 20', () => {
    const many = Array.from({ length: 40 }, (_, i) => `m${i}`);
    assert.equal(normalizeModels(many).length, 20);
  });
});

describe('protocol/reasoning', () => {
  it('保留 DeepSeek assistant 历史中的 reasoning_content', () => {
    const payload = normalizeChatPayload({
      messages: [
        { role: 'assistant', content: '答案', reasoning_content: '思考过程' },
        { role: 'user', content: '继续' },
      ],
    });

    assert.equal((payload.messages as Array<Record<string, unknown>>)[0]?.reasoning_content, '思考过程');
  });

  it('兼容 reasoning 字段和 reasoning 内容块并映射为 reasoning_content', () => {
    const payload = normalizeChatPayload({
      thinking: { type: 'enabled' },
      messages: [
        { role: 'assistant', content: '答案', reasoning: '旧字段思考' },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '块思考' },
            { type: 'text', text: '块答案' },
          ],
        },
      ],
    });
    const messages = payload.messages as Array<Record<string, unknown>>;

    assert.equal(messages[0]?.reasoning_content, '旧字段思考');
    assert.equal(messages[1]?.reasoning_content, '块思考');
    assert.equal(messages[1]?.content, '块答案');
    assert.deepEqual(payload.thinking, { type: 'enabled' });
  });
});

describe('protocol/responses', () => {
  it('把 Responses 字符串输入和 instructions 转为 Chat messages', () => {
    assert.deepEqual(responseInputToChatMessages('你好', '保持简洁'), [
      { role: 'developer', content: '保持简洁' },
      { role: 'user', content: '你好' },
    ]);
  });

  it('保留 Responses 多轮消息与 reasoning item', () => {
    assert.deepEqual(
      responseInputToChatMessages([
        { role: 'user', content: [{ type: 'input_text', text: '问题' }] },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: '思考' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: '答案' }] },
      ]),
      [
        { role: 'user', content: '问题' },
        { role: 'assistant', content: '答案', reasoning_content: '思考' },
      ],
    );
  });
});

describe('contribution/其他', () => {
  it('maskBaseUrl 只保留 origin 与 pathname', () => {
    assert.equal(maskBaseUrl('https://api.example.com/v1?token=secret#x'), 'https://api.example.com/v1');
  });

  it('同一 apiKey 稳定映射到同一 provider 名，使重复提交表现为更新', () => {
    assert.equal(contributionProviderName('sk-a'), contributionProviderName('sk-a'));
    assert.notEqual(contributionProviderName('sk-a'), contributionProviderName('sk-b'));
  });

  it('公开邮箱 ID 使用星号脱敏且不包含邮箱后缀', () => {
    assert.equal(contributorDisplayName('dev@example.com', 'email'), 'd*v');
    assert.equal(contributorDisplayName('123456@qq.com', 'email'), '1****6');
    assert.equal(contributorDisplayName('a@example.com', 'email'), '*');
    assert.equal(contributorDisplayName('ab@example.com', 'email'), 'a*');
    assert.equal(contributorDisplayName('LoosePrince', 'github'), 'LoosePrince');
  });

  it('公开贡献 DTO 不泄露原始邮箱或可反查 QQ ID 的头像', () => {
    const dto = toContributionDTO(
      provider({
        id: 20,
        source: 'contributed',
        contributor: '123456@qq.com',
        contributorType: 'email',
        models: ['m1'],
      }),
    );

    assert.equal(dto.contributor, '1****6');
    assert.equal(dto.displayName, '1****6');
    assert.equal(dto.avatarUrl, null);
    assert.equal(JSON.stringify(dto).includes('@qq.com'), false);
    assert.equal(JSON.stringify(dto).includes('123456'), false);
  });
});