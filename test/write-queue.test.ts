import { strict as assert } from 'node:assert';
import { after, beforeEach, describe, it } from 'node:test';

import { setDb, LsqliteError, serializeTransactionBody, type LsqliteClient, type LsqliteStatement } from '../src/db/lsqlite';
import type { RequestEventInput } from '../src/db/repo/requests';
import { enqueueRequestEvent, flush, getWriteQueueStats } from '../src/runtime/write-queue';

/**
 * 写队列回归测试。
 *
 * 复现面板上的事故：Lsqlite 用 body-parser 把事务请求体限制在 2MB，旧实现只按
 * 语句条数切批，长上下文请求（开启正文记录后）会撑爆单个事务，413 之后失败子批
 * 被放回队首，正常事件永远排不到 -> 队列只涨不跌。
 *
 * 这里用一个「超过字节上限就抛 413」的假 Lsqlite 替身，验证队列能通过降级把批次
 * 落盘，而不是把事件堆在队列里。
 */

function makeEvent(index: number, bodyChars: number): RequestEventInput {
  return {
    traceId: `trace-${index}`,
    startedAt: '2026-09-11T00:00:00.000Z',
    firstResponseAt: '2026-09-11T00:00:01.000Z',
    completedAt: '2026-09-11T00:00:02.000Z',
    ttfbMs: 1_000,
    totalMs: 2_000,
    ip: `10.0.0.${index % 250}`,
    requestedModel: 'test-model',
    finalModel: 'test-model',
    finalProviderId: 1,
    finalProviderName: 'provider-a',
    finalRole: 'primary',
    stream: false,
    outcome: 'upstream_ok',
    cacheHit: false,
    success: true,
    httpStatus: 200,
    errorCode: null,
    errorMessage: null,
    promptTokens: 1,
    completionTokens: 1,
    fallbackTriggered: false,
    attempts: [],
    content: {
      clientRequest: { text: 'x'.repeat(bodyChars) },
      upstreamRequest: null,
      aiResponse: null,
    },
  };
}

/** 安装一个按字节上限拒绝事务的替身，返回每个成功提交的请求体 */
function installFakeDb(limitBytes: number): string[] {
  const accepted: string[] = [];

  const client = {
    async transaction(statements: LsqliteStatement[]): Promise<unknown[]> {
      const body = serializeTransactionBody(statements);
      if (Buffer.byteLength(body, 'utf8') > limitBytes) {
        throw new LsqliteError('request entity too large', 'REQUEST_ERROR', undefined, 413);
      }
      accepted.push(body);
      return [];
    },
  } as unknown as LsqliteClient;

  setDb(client);
  return accepted;
}

function delta(before: ReturnType<typeof getWriteQueueStats>) {
  const after = getWriteQueueStats();
  return {
    persisted: after.persisted - before.persisted,
    dropped: after.dropped - before.dropped,
    contentDropped: after.contentDropped - before.contentDropped,
    pending: after.pending,
  };
}

describe('落盘写队列的体积降级', () => {
  beforeEach(() => {
    setDb(null);
  });

  after(() => {
    setDb(null);
  });

  it('子批超限时按事件拆分，全部落盘且不积压', async () => {
    // 单事件约 43KB 可以通过，6 个事件的子批约 260KB 会被拒
    installFakeDb(120_000);
    const before = getWriteQueueStats();

    for (let index = 0; index < 6; index += 1) {
      enqueueRequestEvent(makeEvent(index, 40_000));
    }

    await flush();

    assert.deepEqual(delta(before), { persisted: 6, dropped: 0, contentDropped: 0, pending: 0 });
  });

  it('单事件仍超限时丢正文保元数据，不把事件留在队列里', async () => {
    installFakeDb(20_000);
    const before = getWriteQueueStats();

    enqueueRequestEvent(makeEvent(1, 60_000));

    await flush();

    const result = delta(before);
    assert.equal(result.persisted, 1);
    assert.equal(result.dropped, 0);
    assert.equal(result.contentDropped, 1);
    assert.equal(result.pending, 0);
  });

  it('连接类错误把批次退回队尾，不丢事件且不阻塞后续 flush', async () => {
    const failing = {
      async transaction(): Promise<unknown[]> {
        throw new LsqliteError('fetch failed', 'NETWORK_ERROR');
      },
    } as unknown as LsqliteClient;
    setDb(failing);

    const before = getWriteQueueStats();
    enqueueRequestEvent(makeEvent(2, 10));

    await flush();

    const failed = delta(before);
    assert.equal(failed.persisted, 0);
    assert.equal(failed.dropped, 0);
    assert.equal(failed.pending, 1);

    // 数据库恢复后，退回队尾的事件仍能被落盘
    installFakeDb(10_000_000);
    await flush();

    const recovered = delta(before);
    assert.equal(recovered.persisted, 1);
    assert.equal(recovered.pending, 0);
  });
});
