import { getDb } from '../lsqlite';

const MAX_RECENT_ENTRIES = 64;
const MAX_RECENT_BYTES = 16 * 1024 * 1024;
const recentResponses = new Map<string, CachedResponse>();
let recentBytes = 0;

export interface CachedResponse {
  cacheKey: string;
  protocol: 'chat' | 'responses';
  stream: boolean;
  requestedModel: string | null;
  contentType: string;
  responseBody: string;
  actualModel: string | null;
  finalProviderId: number | null;
  finalProviderName: string | null;
  finalRole: 'primary' | 'parallel' | 'fallback' | null;
  promptTokens: number;
  completionTokens: number;
  clientRequestBody?: string | null;
  sourceTraceId?: string | null;
  createdAt: string;
}

interface CacheRow {
  cache_key: string;
  protocol: string;
  stream: number;
  requested_model: string | null;
  content_type: string;
  response_body: string;
  actual_model: string | null;
  final_provider_id: number | null;
  final_provider_name: string | null;
  final_role: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  client_request_body: string | null;
  source_trace_id: string | null;
  created_at: string;
}

function toCachedResponse(row: CacheRow): CachedResponse {
  return {
    cacheKey: row.cache_key,
    protocol: row.protocol as CachedResponse['protocol'],
    stream: row.stream === 1,
    requestedModel: row.requested_model,
    contentType: row.content_type,
    responseBody: row.response_body,
    actualModel: row.actual_model,
    finalProviderId: row.final_provider_id,
    finalProviderName: row.final_provider_name,
    finalRole: (row.final_role as CachedResponse['finalRole']) ?? null,
    promptTokens: Number(row.prompt_tokens) || 0,
    completionTokens: Number(row.completion_tokens) || 0,
    clientRequestBody: row.client_request_body,
    sourceTraceId: row.source_trace_id,
    createdAt: row.created_at,
  };
}

function forgetRecent(cacheKey: string): void {
  const existing = recentResponses.get(cacheKey);
  if (!existing) return;
  recentBytes -= Buffer.byteLength(existing.responseBody);
  recentResponses.delete(cacheKey);
}

function rememberRecent(response: CachedResponse): void {
  forgetRecent(response.cacheKey);
  const bytes = Buffer.byteLength(response.responseBody);
  if (bytes > MAX_RECENT_BYTES) return;

  recentResponses.set(response.cacheKey, response);
  recentBytes += bytes;
  while (recentResponses.size > MAX_RECENT_ENTRIES || recentBytes > MAX_RECENT_BYTES) {
    const oldestKey = recentResponses.keys().next().value as string | undefined;
    if (!oldestKey) break;
    forgetRecent(oldestKey);
  }
}

function isReusable(response: CachedResponse, reuseHours: number): boolean {
  const createdAtMs = Date.parse(response.createdAt);
  return Number.isFinite(createdAtMs) && createdAtMs >= Date.now() - reuseHours * 3_600_000;
}

function recordHit(cacheKey: string): void {
  void getDb()
    .execute(
      `update response_cache
          set last_hit_at = ?, hit_count = hit_count + 1
        where cache_key = ?`,
      [new Date().toISOString(), cacheKey],
    )
    .catch((error) => console.warn(`[Cache] failed to update hit count: ${(error as Error).message}`));
}

export async function findReusableResponse(cacheKey: string, reuseHours: number): Promise<CachedResponse | null> {
  const recent = recentResponses.get(cacheKey);
  if (recent && isReusable(recent, reuseHours)) {
    // 命中后移到队尾，维持 LRU 淘汰顺序。
    recentResponses.delete(cacheKey);
    recentResponses.set(cacheKey, recent);
    recordHit(cacheKey);
    return recent;
  }
  if (recent) forgetRecent(cacheKey);

  const cutoff = new Date(Date.now() - reuseHours * 3_600_000).toISOString();
  const row = await getDb().selectOne<CacheRow>(
    `select cache_key, protocol, stream, requested_model, content_type, response_body,
            actual_model, final_provider_id, final_provider_name, final_role,
            prompt_tokens, completion_tokens, client_request_body, source_trace_id, created_at
       from response_cache
      where cache_key = ? and created_at >= ?`,
    [cacheKey, cutoff],
  );
  if (!row) return null;

  const response = toCachedResponse(row);
  rememberRecent(response);

  recordHit(cacheKey);

  return response;
}

export async function pruneExpiredCachedResponses(reuseHours: number): Promise<number> {
  const cutoffMs = Date.now() - reuseHours * 3_600_000;
  for (const response of recentResponses.values()) {
    const createdAtMs = Date.parse(response.createdAt);
    if (!Number.isFinite(createdAtMs) || createdAtMs < cutoffMs) forgetRecent(response.cacheKey);
  }

  const cutoff = new Date(cutoffMs).toISOString();
  const result = await getDb().execute('delete from response_cache where created_at < ?', [cutoff]);
  return result.rowCount ?? 0;
}

export async function saveCachedResponse(input: CachedResponse): Promise<void> {
  rememberRecent(input);
  await getDb().execute(
    `insert into response_cache (
       cache_key, protocol, stream, requested_model, content_type, response_body,
       actual_model, final_provider_id, final_provider_name, final_role,
       prompt_tokens, completion_tokens, client_request_body, source_trace_id, created_at, last_hit_at, hit_count
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, 0)
     on conflict (cache_key) do update set
       protocol = excluded.protocol,
       stream = excluded.stream,
       requested_model = excluded.requested_model,
       content_type = excluded.content_type,
       response_body = excluded.response_body,
       actual_model = excluded.actual_model,
       final_provider_id = excluded.final_provider_id,
       final_provider_name = excluded.final_provider_name,
       final_role = excluded.final_role,
       prompt_tokens = excluded.prompt_tokens,
       completion_tokens = excluded.completion_tokens,
       client_request_body = excluded.client_request_body,
       source_trace_id = excluded.source_trace_id,
       created_at = excluded.created_at`,
    [
      input.cacheKey,
      input.protocol,
      input.stream ? 1 : 0,
      input.requestedModel,
      input.contentType,
      input.responseBody,
      input.actualModel,
      input.finalProviderId,
      input.finalProviderName,
      input.finalRole,
      input.promptTokens,
      input.completionTokens,
      input.clientRequestBody ?? null,
      input.sourceTraceId ?? null,
      input.createdAt,
    ],
  );
}