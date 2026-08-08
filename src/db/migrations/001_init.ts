/**
 * 001_init — 规范化 schema。
 *
 * 取代原先的单表 `Provider` + JSON 混装：
 *   stats.modelConfig      -> settings
 *   providers.models JSON  -> provider_models
 *   priority 组隐式规则     -> priority_groups
 *   负 priority 虚拟行      -> providers.kind + 独立汇总表
 *   stats.models/.ips      -> models / ips / *_usage_daily
 *   内存 200 条日志         -> requests / request_attempts
 */

export const migration001Init = {
  id: '001_init',
  statements: [
    // ---------- 配置域 ----------
    `create table if not exists settings (
      key text primary key,
      value text not null,
      updated_at text not null
    )`,

    `create table if not exists providers (
      id integer primary key autoincrement,
      name text not null unique,
      base_url text not null,
      api_key text not null,
      priority integer not null default 0,
      kind text not null default 'primary',
      enabled integer not null default 1,
      is_env integer not null default 0,
      source text not null default 'managed',
      contributor text,
      contributor_type text,
      created_at text not null,
      updated_at text not null
    )`,
    `create index if not exists idx_providers_routing on providers (enabled, kind, priority, id)`,
    `create index if not exists idx_providers_source on providers (source)`,

    `create table if not exists provider_models (
      id integer primary key autoincrement,
      provider_id integer not null references providers(id) on delete cascade,
      model text not null,
      sort_order integer not null default 0,
      unique (provider_id, model)
    )`,
    `create index if not exists idx_provider_models_model on provider_models (model)`,

    // 优先级组升级为实体，修掉「组内规则取第一个 provider 的 rule」
    `create table if not exists priority_groups (
      priority integer primary key,
      rule text not null default 'priority',
      timeout_ms integer,
      updated_at text not null
    )`,

    // ---------- 维度表 ----------
    `create table if not exists ips (
      id integer primary key autoincrement,
      ip text not null unique,
      first_seen_at text not null,
      last_seen_at text not null
    )`,

    `create table if not exists models (
      id integer primary key autoincrement,
      name text not null unique,
      first_seen_at text not null,
      last_seen_at text not null
    )`,

    // ---------- 可追溯明细 ----------
    `create table if not exists requests (
      id integer primary key autoincrement,
      trace_id text not null unique,
      started_at text not null,
      first_response_at text,
      completed_at text not null,
      ttfb_ms integer,
      total_ms integer,
      ip_id integer references ips(id),
      requested_model text,
      final_model text,
      final_provider_id integer references providers(id),
      final_provider_name text,
      final_role text,
      stream integer not null default 0,
      success integer not null default 0,
      http_status integer,
      error_code text,
      error_message text,
      prompt_tokens integer not null default 0,
      completion_tokens integer not null default 0,
      fallback_triggered integer not null default 0
    )`,
    `create index if not exists idx_requests_started on requests (started_at desc)`,
    `create index if not exists idx_requests_success on requests (success, started_at desc)`,
    `create index if not exists idx_requests_model on requests (requested_model, started_at desc)`,
    `create index if not exists idx_requests_ip on requests (ip_id, started_at desc)`,
    `create index if not exists idx_requests_provider on requests (final_provider_id, started_at desc)`,

    // 包含当前实现被静默丢弃的中途重试失败
    `create table if not exists request_attempts (
      id integer primary key autoincrement,
      request_id integer not null references requests(id) on delete cascade,
      seq integer not null,
      role text not null,
      provider_id integer references providers(id),
      provider_name text not null,
      priority integer,
      attempted_model text,
      actual_model text,
      timeout_ms integer,
      status text not null,
      error_message text,
      started_at text not null,
      duration_ms integer
    )`,
    `create index if not exists idx_attempts_request on request_attempts (request_id, seq)`,
    `create index if not exists idx_attempts_provider on request_attempts (provider_id, started_at desc)`,

    // ---------- 日聚合（面板读这里，避免全表扫描） ----------
    `create table if not exists provider_usage_daily (
      provider_id integer not null,
      provider_name text not null,
      day text not null,
      requests integer not null default 0,
      success integer not null default 0,
      failed integer not null default 0,
      prompt_tokens integer not null default 0,
      completion_tokens integer not null default 0,
      primary key (provider_id, day)
    )`,
    `create index if not exists idx_provider_usage_day on provider_usage_daily (day desc)`,

    `create table if not exists model_usage_daily (
      requested_model text not null,
      actual_model text not null,
      day text not null,
      requests integer not null default 0,
      prompt_tokens integer not null default 0,
      completion_tokens integer not null default 0,
      primary key (requested_model, actual_model, day)
    )`,
    `create index if not exists idx_model_usage_day on model_usage_daily (day desc)`,

    `create table if not exists ip_usage_daily (
      ip_id integer not null,
      day text not null,
      requests integer not null default 0,
      tokens integer not null default 0,
      primary key (ip_id, day)
    )`,
    `create index if not exists idx_ip_usage_day on ip_usage_daily (day desc)`,

    // 全站汇总单行，公开统计接口只读它
    `create table if not exists global_usage (
      id integer primary key check (id = 1),
      requests integer not null default 0,
      success integer not null default 0,
      failed integer not null default 0,
      prompt_tokens integer not null default 0,
      completion_tokens integer not null default 0
    )`,
    `insert or ignore into global_usage (id, requests, success, failed, prompt_tokens, completion_tokens)
      values (1, 0, 0, 0, 0, 0)`,
  ],
};