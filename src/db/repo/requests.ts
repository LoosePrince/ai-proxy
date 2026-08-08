/**
 * requests / request_attempts 仓储 —— 可追溯记录的写入与查询。
 *
 * 写入设计（对应旧实现的三个缺陷）：
 *   1. 旧实现日志只在内存 200 条上限、重启即丢 -> 现在全量落盘可分页查询
 *   2. 旧实现中途重试失败被静默丢弃（只 console.warn）-> 现在每个 attempt 都入库
 *   3. 旧实现 stats JSON 读改写并发丢更新 -> 现在聚合走 SQL 原子累加
 *
 * 一次请求的明细 + attempts + 四张聚合表全部在**单次事务**内完成：
 * 既保证一致性，也把远程 HTTP 往返压到 1 次。
 *
 * attempts 通过 `(select id from requests where trace_id = ?)` 子查询关联父行 ——
 * 同一事务内前序语句已可见，因此无需先读回自增 id。
 */

import { getDb } from '../lsqlite';
import type { LsqliteStatement } from '../lsqlite';
import type {
  AttemptRole,
  AttemptStatus,
  Paged,
  RequestAttemptDTO,
  RequestDetailDTO,
  RequestListQuery,
  RequestSummaryDTO,
} from '../../types/api';

export interface AttemptEventInput {
  seq: number;
  role: AttemptRole;
  providerId: number | null;
  providerName: string;
  priority: number | null;
  attemptedModel: string | null;
  actualModel: string | null;
  timeoutMs: number | null;
  status: AttemptStatus;
  errorMessage: string | null;
  startedAt: string;
  durationMs: number | null;
}

export interface RequestEventInput {
  traceId: string;
  startedAt: string;
  firstResponseAt: string | null;
  completedAt: string;
  ttfbMs: number | null;
  totalMs: number | null;
  ip: string | null;
  requestedModel: string | null;
  finalModel: string | null;
  finalProviderId: number | null;
  finalProviderName: string | null;
  finalRole: AttemptRole | null;
  stream: boolean;
  success: boolean;
  httpStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  promptTokens: number;
  completionTokens: number;
  fallbackTriggered: boolean;
  attempts: AttemptEventInput[];
}

const UNKNOWN_MODEL = '(unspecified)';

/** UTC 日期分桶键，聚合表按此对齐 */
function dayOf(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

function bool(value: boolean): number {
  return value ? 1 : 0;
}

/**
 * 把一批请求事件编译成一组语句。
 * 顺序有意义：维度行先落地，明细与聚合才能通过子查询引用它们。
 */
export function buildIngestStatements(events: RequestEventInput[]): LsqliteStatement[] {
  if (events.length === 0) return [];

  const statements: LsqliteStatement[] = [];
  const now = new Date().toISOString();

  // ---- 维度表：IP 与模型 ----
  const ips = new Set<string>();
  const models = new Set<string>();

  for (const event of events) {
    if (event.ip) ips.add(event.ip);
    for (const name of [event.requestedModel, event.finalModel]) {
      if (name) models.add(name);
    }
    for (const attempt of event.attempts) {
      for (const name of [attempt.attemptedModel, attempt.actualModel]) {
        if (name) models.add(name);
      }
    }
  }

  for (const ip of ips) {
    statements.push({
      sql: `insert into ips (ip, first_seen_at, last_seen_at) values (?, ?, ?)
            on conflict (ip) do update set last_seen_at = excluded.last_seen_at`,
      params: [ip, now, now],
      mode: 'write',
    });
  }

  for (const model of models) {
    statements.push({
      sql: `insert into models (name, first_seen_at, last_seen_at) values (?, ?, ?)
            on conflict (name) do update set last_seen_at = excluded.last_seen_at`,
      params: [model, now, now],
      mode: 'write',
    });
  }

  // ---- 明细、attempts、聚合 ----
  for (const event of events) {
    const day = dayOf(event.startedAt);
    const tokens = event.promptTokens + event.completionTokens;

    statements.push({
      sql: `insert into requests (
              trace_id, started_at, first_response_at, completed_at, ttfb_ms, total_ms,
              ip_id, requested_model, final_model, final_provider_id, final_provider_name,
              final_role, stream, success, http_status, error_code, error_message,
              prompt_tokens, completion_tokens, fallback_triggered
            ) values (
              ?, ?, ?, ?, ?, ?,
              (select id from ips where ip = ?), ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?,
              ?, ?, ?
            )
            on conflict (trace_id) do nothing`,
      params: [
        event.traceId,
        event.startedAt,
        event.firstResponseAt,
        event.completedAt,
        event.ttfbMs,
        event.totalMs,
        event.ip,
        event.requestedModel,
        event.finalModel,
        event.finalProviderId,
        event.finalProviderName,
        event.finalRole,
        bool(event.stream),
        bool(event.success),
        event.httpStatus,
        event.errorCode,
        event.errorMessage,
        event.promptTokens,
        event.completionTokens,
        bool(event.fallbackTriggered),
      ],
      mode: 'write',
    });

    for (const attempt of event.attempts) {
      statements.push({
        sql: `insert into request_attempts (
                request_id, seq, role, provider_id, provider_name, priority,
                attempted_model, actual_model, timeout_ms, status, error_message,
                started_at, duration_ms
              ) values (
                (select id from requests where trace_id = ?), ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?
              )`,
        params: [
          event.traceId,
          attempt.seq,
          attempt.role,
          attempt.providerId,
          attempt.providerName,
          attempt.priority,
          attempt.attemptedModel,
          attempt.actualModel,
          attempt.timeoutMs,
          attempt.status,
          attempt.errorMessage,
          attempt.startedAt,
          attempt.durationMs,
        ],
        mode: 'write',
      });
    }

    // 全站汇总：公开统计接口只读这一行，避免全表扫描
    statements.push({
      sql: `update global_usage set
              requests = requests + 1,
              success = success + ?,
              failed = failed + ?,
              prompt_tokens = prompt_tokens + ?,
              completion_tokens = completion_tokens + ?
            where id = 1`,
      params: [
        bool(event.success),
        bool(!event.success),
        event.promptTokens,
        event.completionTokens,
      ],
      mode: 'write',
    });

    // provider 维度：provider_name 反规范化保存，provider 删除后历史仍可读
    if (event.finalProviderId !== null) {
      statements.push({
        sql: `insert into provider_usage_daily (
                provider_id, provider_name, day, requests, success, failed,
                prompt_tokens, completion_tokens
              ) values (?, ?, ?, 1, ?, ?, ?, ?)
              on conflict (provider_id, day) do update set
                requests = provider_usage_daily.requests + excluded.requests,
                success = provider_usage_daily.success + excluded.success,
                failed = provider_usage_daily.failed + excluded.failed,
                prompt_tokens = provider_usage_daily.prompt_tokens + excluded.prompt_tokens,
                completion_tokens = provider_usage_daily.completion_tokens + excluded.completion_tokens,
                provider_name = excluded.provider_name`,
        params: [
          event.finalProviderId,
          event.finalProviderName ?? '',
          day,
          bool(event.success),
          bool(!event.success),
          event.promptTokens,
          event.completionTokens,
        ],
        mode: 'write',
      });
    }

    // 模型维度：取代旧 stats.models[x].actualResolved 嵌套 JSON
    const requestedModel = event.requestedModel ?? UNKNOWN_MODEL;
    const actualModel = event.finalModel ?? requestedModel;
    statements.push({
      sql: `insert into model_usage_daily (
              requested_model, actual_model, day, requests, prompt_tokens, completion_tokens
            ) values (?, ?, ?, 1, ?, ?)
            on conflict (requested_model, actual_model, day) do update set
              requests = model_usage_daily.requests + excluded.requests,
              prompt_tokens = model_usage_daily.prompt_tokens + excluded.prompt_tokens,
              completion_tokens = model_usage_daily.completion_tokens + excluded.completion_tokens`,
      params: [requestedModel, actualModel, day, event.promptTokens, event.completionTokens],
      mode: 'write',
    });

    if (event.ip) {
      statements.push({
        sql: `insert into ip_usage_daily (ip_id, day, requests, tokens)
              values ((select id from ips where ip = ?), ?, 1, ?)
              on conflict (ip_id, day) do update set
                requests = ip_usage_daily.requests + excluded.requests,
                tokens = ip_usage_daily.tokens + excluded.tokens`,
        params: [event.ip, day, tokens],
        mode: 'write',
      });
    }
  }

  return statements;
}

export async function persistRequests(events: RequestEventInput[]): Promise<void> {
  const statements = buildIngestStatements(events);
  if (statements.length === 0) return;
  await getDb().transaction(statements);
}

// ---------------------------------------------------------------- 查询路径

interface RequestRow {
  id: number;
  trace_id: string;
  started_at: string;
  completed_at: string | null;
  ttfb_ms: number | null;
  total_ms: number | null;
  ip: string | null;
  requested_model: string | null;
  final_model: string | null;
  final_provider_name: string | null;
  final_role: string | null;
  stream: number;
  success: number;
  http_status: number | null;
  error_code: string | null;
  error_message: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  fallback_triggered: number;
  attempt_count: number;
}

const REQUEST_SELECT = `
  r.id, r.trace_id, r.started_at, r.completed_at, r.ttfb_ms, r.total_ms,
  i.ip as ip, r.requested_model, r.final_model, r.final_provider_name, r.final_role,
  r.stream, r.success, r.http_status, r.error_code, r.error_message,
  r.prompt_tokens, r.completion_tokens, r.fallback_triggered,
  (select count(*) from request_attempts a where a.request_id = r.id) as attempt_count`;

function toSummary(row: RequestRow): RequestSummaryDTO {
  return {
    id: row.id,
    traceId: row.trace_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    ttfbMs: row.ttfb_ms,
    totalMs: row.total_ms,
    ip: row.ip,
    requestedModel: row.requested_model,
    finalModel: row.final_model,
    finalProviderName: row.final_provider_name,
    finalRole: (row.final_role as AttemptRole | null) ?? null,
    stream: row.stream === 1,
    success: row.success === 1,
    httpStatus: row.http_status,
    errorMessage: row.error_message,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    fallbackTriggered: row.fallback_triggered === 1,
    attemptCount: row.attempt_count,
  };
}

/** 把可选筛选条件编译成 where 片段，全部参数化 */
function buildFilter(query: RequestListQuery): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];

  if (query.success !== undefined) {
    parts.push('r.success = ?');
    params.push(query.success ? 1 : 0);
  }
  if (query.requestedModel) {
    parts.push('r.requested_model = ?');
    params.push(query.requestedModel);
  }
  if (query.ip) {
    parts.push('i.ip = ?');
    params.push(query.ip);
  }
  if (query.providerId !== undefined) {
    parts.push('r.final_provider_id = ?');
    params.push(query.providerId);
  }
  if (query.from) {
    parts.push('r.started_at >= ?');
    params.push(query.from);
  }
  if (query.to) {
    parts.push('r.started_at <= ?');
    params.push(query.to);
  }

  return { sql: parts.length ? `where ${parts.join(' and ')}` : '', params };
}

export async function queryRequests(query: RequestListQuery = {}): Promise<Paged<RequestSummaryDTO>> {
  const db = getDb();
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);
  const filter = buildFilter(query);

  const [rows, countRow] = await Promise.all([
    db.select<RequestRow>(
      `select ${REQUEST_SELECT}
       from requests r
       left join ips i on i.id = r.ip_id
       ${filter.sql}
       order by r.started_at desc, r.id desc
       limit ? offset ?`,
      [...filter.params, limit, offset],
    ),
    db.selectOne<{ total: number }>(
      `select count(*) as total
       from requests r
       left join ips i on i.id = r.ip_id
       ${filter.sql}`,
      filter.params,
    ),
  ]);

  return {
    items: rows.map(toSummary),
    total: countRow?.total ?? 0,
    limit,
    offset,
  };
}

interface AttemptRow {
  id: number;
  seq: number;
  role: string;
  provider_id: number | null;
  provider_name: string | null;
  attempted_model: string | null;
  actual_model: string | null;
  timeout_ms: number | null;
  status: string;
  error_message: string | null;
  started_at: string;
  duration_ms: number | null;
}

function toAttempt(row: AttemptRow): RequestAttemptDTO {
  return {
    id: row.id,
    seq: row.seq,
    role: row.role as AttemptRole,
    providerId: row.provider_id,
    providerName: row.provider_name,
    attemptedModel: row.attempted_model,
    actualModel: row.actual_model,
    timeoutMs: row.timeout_ms,
    status: row.status as AttemptStatus,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
  };
}

export async function getRequestDetail(id: number): Promise<RequestDetailDTO | null> {
  const db = getDb();

  const row = await db.selectOne<RequestRow>(
    `select ${REQUEST_SELECT}
     from requests r
     left join ips i on i.id = r.ip_id
     where r.id = ?`,
    [id],
  );
  if (!row) return null;

  const attempts = await db.select<AttemptRow>(
    `select id, seq, role, provider_id, provider_name, attempted_model, actual_model,
            timeout_ms, status, error_message, started_at, duration_ms
     from request_attempts
     where request_id = ?
     order by seq asc`,
    [id],
  );

  return {
    ...toSummary(row),
    errorCode: row.error_code,
    attempts: attempts.map(toAttempt),
  };
}

/**
 * 按保留天数清理明细。
 * 只删 requests（attempts 靠 on delete cascade 跟随），聚合表永久保留，
 * 因此清理历史明细不会让面板数字回退。
 */
export async function pruneOldRequests(retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;

  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const result = await getDb().execute('delete from requests where started_at < ?', [cutoff]);
  return result.rowCount ?? 0;
}