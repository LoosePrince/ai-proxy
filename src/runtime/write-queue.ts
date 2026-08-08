/**
 * 落盘写队列。
 *
 * 旧实现每次代理请求同步写 7 次数据库（3 次 upsert 兜底虚拟行 + 4 次 JSON 整列回写）。
 * Lsqlite 上每次写都是一次 HTTPS 往返，照搬会让 AI 请求延迟增加数秒。
 *
 * 这里改成：热路径只做内存入队（同步、零延迟），后台按批合并成**单次事务**落盘。
 * 一次 flush 覆盖 N 个请求的明细 + attempts + 四张聚合表。
 *
 * 队列有界：满了丢最旧的事件并计数告警，宁可丢统计也不拖垮代理服务。
 */

import { buildIngestStatements, persistRequests, type RequestEventInput } from '../db/repo/requests';
import { getDb } from '../db/lsqlite';

const FLUSH_INTERVAL_MS = 1_000;
const FLUSH_BATCH_SIZE = 50;
const MAX_QUEUE_SIZE = 5_000;
const MAX_FLUSH_RETRIES = 2;

/**
 * Lsqlite 单次 /api/transaction 的语句上限（服务端强制，超出直接 400）。
 * 一个请求事件会展开成 5~8 条语句，所以切批必须按语句数而不是事件数，
 * 否则批次一大就整体失败、重试耗尽后丢日志。
 */
const MAX_STATEMENTS_PER_TX = 100;

interface QueueStats {
  enqueued: number;
  persisted: number;
  dropped: number;
  failedFlushes: number;
  lastError: string | null;
  lastFlushAtMs: number | null;
}

const stats: QueueStats = {
  enqueued: 0,
  persisted: 0,
  dropped: 0,
  failedFlushes: 0,
  lastError: null,
  lastFlushAtMs: null,
};

let queue: RequestEventInput[] = [];
let timer: NodeJS.Timeout | null = null;
let flushing = false;
let stopped = false;

/** 热路径调用点：同步入队，不做任何 IO */
export function enqueueRequestEvent(event: RequestEventInput): void {
  if (stopped) return;

  if (queue.length >= MAX_QUEUE_SIZE) {
    // 丢最旧的：新数据比陈旧数据更有价值，且能保证队列不无界增长
    queue.shift();
    stats.dropped += 1;
    if (stats.dropped % 100 === 1) {
      console.warn(`[WriteQueue] queue full, dropped ${stats.dropped} events so far`);
    }
  }

  queue.push(event);
  stats.enqueued += 1;

  // 达到批量阈值立即触发，不必等定时器
  if (queue.length >= FLUSH_BATCH_SIZE) void flush();
}

/**
 * 按事件切分成若干子批，保证每个子批生成的语句数不超过事务上限。
 *
 * 关键点：切分必须以**事件**为边界、由每个子批各自生成语句，而不是直接切最终
 * 语句数组。语句之间存在引用关系（明细行用 `(select id from ips where ip = ?)`
 * 关联前面刚插入的维度行），横切语句数组会把维度行和引用它的明细行分到不同
 * 事务，一旦后一个事务失败就留下引用空缺。按事件切分则每个子批都自带维度行，
 * 单个事务内自洽。
 */
function chunkByStatementLimit(batch: RequestEventInput[]): RequestEventInput[][] {
  const chunks: RequestEventInput[][] = [];
  let pending: RequestEventInput[] = [];

  for (const event of batch) {
    const next = [...pending, event];

    if (buildIngestStatements(next).length > MAX_STATEMENTS_PER_TX && pending.length > 0) {
      chunks.push(pending);
      pending = [event];
      continue;
    }

    pending = next;
  }

  if (pending.length > 0) chunks.push(pending);
  return chunks;
}

/** 单个子批的提交，带独立重试。成功返回 true。 */
async function commitChunk(events: RequestEventInput[]): Promise<boolean> {
  const statements = buildIngestStatements(events);
  if (statements.length === 0) return true;

  for (let attempt = 0; attempt <= MAX_FLUSH_RETRIES; attempt += 1) {
    try {
      await getDb().transaction(statements);
      return true;
    } catch (error) {
      stats.lastError = (error as Error)?.message ?? 'unknown flush error';
      if (attempt < MAX_FLUSH_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
      }
    }
  }

  return false;
}

/**
 * 落盘一批。
 *
 * 重试粒度是**子批**而非整批：聚合表用的是 `requests = requests + excluded.requests`
 * 原子累加，已提交的子批若随整批一起重试就会二次累加，把统计数字放大。
 * 因此每个子批各自重试，只把最终失败的子批退回队列。
 */
export async function flush(): Promise<void> {
  if (flushing || queue.length === 0) return;

  flushing = true;
  const batch = queue.splice(0, FLUSH_BATCH_SIZE);

  try {
    const failed: RequestEventInput[] = [];
    let persisted = 0;

    for (const chunk of chunkByStatementLimit(batch)) {
      if (await commitChunk(chunk)) {
        persisted += chunk.length;
      } else {
        failed.push(...chunk);
      }
    }

    stats.persisted += persisted;
    stats.lastFlushAtMs = Date.now();

    if (failed.length === 0) {
      stats.lastError = null;
      return;
    }

    stats.failedFlushes += 1;
    console.error(`[WriteQueue] ${failed.length} events failed to persist: ${stats.lastError}`);

    // 放回队首等下轮重试，但不允许因此突破上界
    const room = MAX_QUEUE_SIZE - queue.length;
    if (room > 0) {
      queue = [...failed.slice(-room), ...queue];
      stats.dropped += Math.max(failed.length - room, 0);
    } else {
      stats.dropped += failed.length;
    }
  } finally {
    flushing = false;
  }
}

export function startWriteQueue(): void {
  if (timer) return;
  stopped = false;
  timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  // 不因为这个定时器阻止进程退出
  timer.unref?.();
}

/** 优雅关闭：停止收新事件，把已入队的尽量写完 */
export async function stopWriteQueue(): Promise<void> {
  stopped = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  // 逐批排空，避免关闭时无限等待
  for (let i = 0; i < 20 && queue.length > 0; i += 1) {
    await flush();
  }

  if (queue.length > 0) {
    console.warn(`[WriteQueue] ${queue.length} events unflushed at shutdown`);
  }
}

export function getWriteQueueStats(): QueueStats & { pending: number } {
  return { ...stats, pending: queue.length };
}

/** 供测试直接同步落盘，绕过队列时序 */
export async function persistNow(events: RequestEventInput[]): Promise<void> {
  await persistRequests(events);
}