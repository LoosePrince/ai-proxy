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
 *
 * 积压事故复盘（面板上「写队列积压 2,035 + 落盘失败 request entity too large」）：
 *   切批原先只看**语句条数**（≤100），完全不看字节数。开启请求正文记录后，一个事务
 *   里塞十几个长上下文请求就会超过 Lsqlite 的 `express.json({ limit: '2mb' })`，
 *   整个子批被判 413。失败子批又被放回**队首**，于是每一轮 flush 都在重试同一批
 *   超大事件，正常事件排在它们后面永远轮不到 -> pending 只涨不跌，直到撞上队列上界
 *   开始丢数据。现在的做法：
 *     1. 切批同时受语句条数与字节数约束；
 *     2. 单个事件仍超限时按事件拆分，正文是唯一可能超限的部分，必要时丢正文保统计；
 *     3. 失败事件退回**队尾**并计失败轮次，连续失败到阈值才丢弃，坏事件不再堵队。
 */

import {
  buildIngestStatements,
  persistRequests,
  type RequestEventInput,
} from '../db/repo/requests';
import { getDb, LsqliteError, serializeTransactionBody } from '../db/lsqlite';

const FLUSH_INTERVAL_MS = 1_000;
const FLUSH_BATCH_SIZE = 50;
const MAX_QUEUE_SIZE = 5_000;
const MAX_FLUSH_RETRIES = 2;

/**
 * Lsqlite 单次 /api/transaction 的语句上限（服务端 zod 强制 `max(100)`，超出直接 400）。
 * 一个请求事件会展开成 5~8 条语句，所以切批必须按语句数而不是事件数，
 * 否则批次一大就整体失败、重试耗尽后丢日志。
 */
const MAX_STATEMENTS_PER_TX = 100;

/**
 * Lsqlite 服务端 body-parser 上限是 2MB。留 25% 余量给 JSON 转义、UTF-8 多字节
 * 与 HTTP 头部，避免刚好卡在边界上仍然被 413。
 */
const MAX_BYTES_PER_TX = 1_500_000;

/**
 * 同一个事件连续失败多少轮后放弃。
 * 失败事件退回队尾，所以阈值只决定「坏事件占着队列多久」，不影响其他事件的落盘。
 */
const MAX_EVENT_FAILURES = 20;

interface QueueStats {
  enqueued: number;
  persisted: number;
  dropped: number;
  /** 因体积超限而丢弃正文、但仍保住了请求元数据与统计的事件数 */
  contentDropped: number;
  failedFlushes: number;
  lastError: string | null;
  lastFlushAtMs: number | null;
}

const stats: QueueStats = {
  enqueued: 0,
  persisted: 0,
  dropped: 0,
  contentDropped: 0,
  failedFlushes: 0,
  lastError: null,
  lastFlushAtMs: null,
};

/** 队列元素带失败计数：同一事件被退回几轮是丢弃判定的依据 */
interface QueuedEvent {
  event: RequestEventInput;
  failures: number;
}

type CommitResult = { ok: true } | { ok: false; error: unknown };

let queue: QueuedEvent[] = [];
let timer: NodeJS.Timeout | null = null;
let flushing = false;
let stopped = false;

function describeError(error: unknown): string {
  if (error instanceof LsqliteError) {
    return error.status ? `${error.message} (HTTP ${error.status})` : error.message;
  }
  return (error as Error)?.message ?? 'unknown flush error';
}

/**
 * 体积超限的判定。
 *
 * 服务端 body-parser 抛错时返回 `{ ok: false, error: { message: 'request entity too large' } }`，
 * 某些反代则直接返回 413。两种都要认出来：对体积问题重试毫无意义，只能降级（拆批 / 丢正文）。
 */
function isOversizeError(error: unknown): boolean {
  if (error instanceof LsqliteError) {
    if (error.status === 413) return true;
    return /entity too large|payload too large/i.test(error.message);
  }
  return false;
}

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

  queue.push({ event, failures: 0 });
  stats.enqueued += 1;

  // 达到批量阈值立即触发，不必等定时器
  if (queue.length >= FLUSH_BATCH_SIZE) void flush();
}

/**
 * 按「语句条数 + 序列化字节数」切分成若干子批。
 *
 * 关键点：切分必须以**事件**为边界、由每个子批各自生成语句，而不是直接切最终
 * 语句数组。语句之间存在引用关系（明细行用 `(select id from ips where ip = ?)`
 * 关联前面刚插入的维度行），横切语句数组会把维度行和引用它的明细行分到不同
 * 事务，一旦后一个事务失败就留下引用空缺。按事件切分则每个子批都自带维度行，
 * 单个事务内自洽。
 */
function chunkByLimits(batch: QueuedEvent[]): QueuedEvent[][] {
  const chunks: QueuedEvent[][] = [];
  let pending: QueuedEvent[] = [];

  for (const item of batch) {
    if (pending.length === 0) {
      // 单个事件先无条件成批：它是否超限留给 commitChunk 的降级路径判断
      pending = [item];
      continue;
    }

    const candidate = [...pending, item];
    const statements = buildIngestStatements(candidate.map((entry) => entry.event));
    const oversize =
      statements.length > MAX_STATEMENTS_PER_TX ||
      Buffer.byteLength(serializeTransactionBody(statements), 'utf8') > MAX_BYTES_PER_TX;

    if (oversize) {
      chunks.push(pending);
      pending = [item];
    } else {
      pending = candidate;
    }
  }

  if (pending.length > 0) chunks.push(pending);
  return chunks;
}

/** 单个子批的提交。体积超限不重试（重试无意义），其余错误按退避重试。 */
async function commitChunk(events: RequestEventInput[]): Promise<CommitResult> {
  const statements = buildIngestStatements(events);
  if (statements.length === 0) return { ok: true };

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= MAX_FLUSH_RETRIES; attempt += 1) {
    try {
      await getDb().transaction(statements);
      return { ok: true };
    } catch (error) {
      lastError = error;
      stats.lastError = describeError(error);

      if (isOversizeError(error)) break;
      if (attempt < MAX_FLUSH_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
      }
    }
  }

  return { ok: false, error: lastError };
}

/**
 * 体积超限后的降级：把子批拆成单事件重试。
 *
 * 正文（client/upstream/response）是唯一会随上下文长度膨胀的部分，因此单事件仍
 * 被 413 拒绝时丢掉正文再提交一次 —— 统计与请求元数据比正文重要，且正文在
 * repo 层已有长度上限，这一步是最后的兜底。
 */
async function persistIndividually(
  chunk: QueuedEvent[],
): Promise<{ persisted: number; failed: QueuedEvent[] }> {
  let persisted = 0;
  const failed: QueuedEvent[] = [];

  for (const item of chunk) {
    let result = await commitChunk([item.event]);

    if (!result.ok && item.event.content && isOversizeError(result.error)) {
      const stripped: RequestEventInput = { ...item.event, content: null };
      result = await commitChunk([stripped]);
      if (result.ok) stats.contentDropped += 1;
    }

    if (result.ok) {
      persisted += 1;
      continue;
    }

    failed.push({ ...item, failures: item.failures + 1 });
  }

  return { persisted, failed };
}

/**
 * 失败事件回队。
 *
 * 放到**队尾**而不是队首：队首回队会让同一批坏事件被反复取出、后面正常事件永远
 * 轮不到，这正是积压只涨不跌的直接原因。连续失败超过阈值的才真正丢弃。
 */
function requeueFailed(failed: QueuedEvent[]): void {
  const survivors: QueuedEvent[] = [];

  for (const item of failed) {
    if (item.failures >= MAX_EVENT_FAILURES) {
      stats.dropped += 1;
      console.error(
        `[WriteQueue] dropping event ${item.event.traceId} after ${item.failures} failed flushes`,
      );
      continue;
    }
    survivors.push(item);
  }

  const room = MAX_QUEUE_SIZE - queue.length;
  if (room <= 0) {
    stats.dropped += survivors.length;
    return;
  }

  const kept = survivors.slice(0, room);
  stats.dropped += survivors.length - kept.length;
  queue.push(...kept);
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
    let persisted = 0;
    const failed: QueuedEvent[] = [];

    for (const chunk of chunkByLimits(batch)) {
      const result = await commitChunk(chunk.map((entry) => entry.event));

      if (result.ok) {
        persisted += chunk.length;
        continue;
      }

      stats.lastError = describeError(result.error);

      if (isOversizeError(result.error)) {
        // 体积问题：拆成单事件，必要时丢正文，尽量保住每一条记录
        const degraded = await persistIndividually(chunk);
        persisted += degraded.persisted;
        failed.push(...degraded.failed);
      } else {
        // 连接 / 5xx / 超时：整批退回队尾等下一轮，避免逐事件重试制造请求风暴
        failed.push(...chunk.map((entry) => ({ ...entry, failures: entry.failures + 1 })));
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

    requeueFailed(failed);
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