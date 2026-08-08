/**
 * Lsqlite HTTP 客户端。
 *
 * Lsqlite 是远程 SQL 服务：每条语句 = 一次 HTTPS 往返。因此这一层只负责
 * 「可靠地把 SQL 送过去」，批量与缓存策略由 runtime/ 层决定，避免在热路径上
 * 出现隐式的多次往返。
 */

export interface LsqliteStatement {
  sql: string;
  params?: unknown[] | Record<string, unknown>;
  mode?: 'auto' | 'read' | 'write';
}

export interface LsqliteResult<Row = Record<string, unknown>> {
  statement: string;
  rows: Row[];
  rowCount: number;
  elapsedMs: number;
}

interface LsqliteEnvelope<Row> {
  ok: boolean;
  database?: { id: string; name: string };
  results?: Array<LsqliteResult<Row>>;
  error?: { code: string; message: string };
}

export class LsqliteError extends Error {
  readonly code: string;
  readonly sql?: string;

  constructor(message: string, code = 'LSQLITE_ERROR', sql?: string) {
    super(message);
    this.name = 'LsqliteError';
    this.code = code;
    this.sql = sql;
  }
}

export interface LsqliteClientOptions {
  baseUrl: string;
  key: string;
  timeoutMs?: number;
  maxRetries?: number;
}

/** 只有网络层与 5xx 值得重试；SQL 语义错误重试无意义 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LsqliteClient {
  private readonly baseUrl: string;
  private readonly key: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: LsqliteClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.key = options.key;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  private async post<Row>(path: string, body: unknown, sqlForError?: string): Promise<LsqliteEnvelope<Row>> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok && isRetryableStatus(response.status)) {
          lastError = new LsqliteError(`HTTP ${response.status}`, 'HTTP_ERROR', sqlForError);
          if (attempt < this.maxRetries) {
            await sleep(200 * 2 ** attempt);
            continue;
          }
          throw lastError;
        }

        const payload = (await response.json()) as LsqliteEnvelope<Row>;
        if (!payload.ok) {
          throw new LsqliteError(
            payload.error?.message || `HTTP ${response.status}`,
            payload.error?.code || 'HTTP_ERROR',
            sqlForError,
          );
        }
        return payload;
      } catch (error) {
        lastError = error;
        // SQL 语义错误直接抛出，不浪费重试
        if (error instanceof LsqliteError && error.code !== 'HTTP_ERROR') throw error;

        const aborted = (error as Error)?.name === 'AbortError';
        if (attempt < this.maxRetries) {
          await sleep(200 * 2 ** attempt);
          continue;
        }
        if (aborted) {
          throw new LsqliteError(`Lsqlite request timed out after ${this.timeoutMs}ms`, 'TIMEOUT', sqlForError);
        }
        throw error instanceof LsqliteError
          ? error
          : new LsqliteError((error as Error)?.message || 'Lsqlite request failed', 'NETWORK_ERROR', sqlForError);
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof Error ? lastError : new LsqliteError('Lsqlite request failed');
  }

  /** 执行单条（或多条，但只有第一条能绑定参数）SQL */
  async query<Row = Record<string, unknown>>(statement: LsqliteStatement): Promise<LsqliteResult<Row>> {
    const payload = await this.post<Row>(
      '/api/query',
      {
        sql: statement.sql,
        params: statement.params ?? [],
        mode: statement.mode ?? 'auto',
      },
      statement.sql,
    );

    const result = payload.results?.[0];
    if (!result) throw new LsqliteError('Lsqlite returned no result', 'EMPTY_RESULT', statement.sql);
    return result;
  }

  async select<Row = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<Row[]> {
    const result = await this.query<Row>({ sql, params, mode: 'read' });
    return result.rows;
  }

  async selectOne<Row = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<Row | null> {
    const rows = await this.select<Row>(sql, params);
    return rows[0] ?? null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<LsqliteResult> {
    return this.query({ sql, params, mode: 'write' });
  }

  /** 原子批量写入。任一语句失败则整体回滚，这是日聚合累加正确性的前提。 */
  async transaction(statements: LsqliteStatement[]): Promise<Array<LsqliteResult>> {
    if (statements.length === 0) return [];
    const payload = await this.post<Record<string, unknown>>('/api/transaction', {
      statements: statements.map((item) => ({
        sql: item.sql,
        params: item.params ?? [],
        mode: item.mode ?? 'write',
      })),
    });
    return payload.results ?? [];
  }

  async health(): Promise<boolean> {
    try {
      const result = await this.query<{ version: string }>({
        sql: 'select sqlite_version() as version',
        mode: 'read',
      });
      return result.rows.length > 0;
    } catch {
      return false;
    }
  }
}

let singleton: LsqliteClient | null = null;

export function getDb(): LsqliteClient {
  if (singleton) return singleton;

  const baseUrl = process.env.LSQLITE_URL;
  const key = process.env.LSQLITE_KEY;
  if (!baseUrl || !key) {
    throw new LsqliteError('LSQLITE_URL and LSQLITE_KEY must be set', 'CONFIG_MISSING');
  }

  singleton = new LsqliteClient({
    baseUrl,
    key,
    timeoutMs: Number(process.env.LSQLITE_TIMEOUT_MS) || 15_000,
  });
  return singleton;
}

/** 供测试注入替身 */
export function setDb(client: LsqliteClient | null): void {
  singleton = client;
}