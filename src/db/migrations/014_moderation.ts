/**
 * 014 —— 多层内容审核系统。
 *
 * 采用规范化表而不是 JSON blob：策略、类别、引擎、作用域绑定、审计事件
 * 各占一张表，与 providers / provider_models 的既有约定一致。
 * 默认策略的种子数据不在这里，而是由 repo 的 seedModerationDefaults()
 * 在启动时写入 —— 它需要引用 core 的类别默认敏感度，SQL 里没法表达。
 */

export const migration014Moderation = {
  id: '014_moderation',
  statements: [
    `create table if not exists moderation_policies (
      id integer primary key autoincrement,
      name text not null unique,
      description text not null default '',
      enabled integer not null default 1,
      is_default integer not null default 0,
      combine_mode text not null default 'strict',
      action text not null default 'empty',
      output_action text not null default 'empty',
      output_response text not null default '',
      response text not null default '',
      hold_back_chars integer not null default 96,
      forbidden_keywords text not null default '',
      created_at text not null,
      updated_at text not null
    )`,

    `create table if not exists moderation_policy_categories (
      policy_id integer not null,
      category text not null,
      enabled integer not null default 1,
      sensitivity integer not null default 50,
      primary key (policy_id, category)
    )`,

    `create table if not exists moderation_policy_detectors (
      policy_id integer not null,
      detector_id text not null,
      enabled integer not null default 1,
      categories_json text not null default '[]',
      primary key (policy_id, detector_id)
    )`,

    `create table if not exists moderation_bindings (
      id integer primary key autoincrement,
      scope_type text not null,
      provider_id integer,
      model text,
      policy_id integer not null,
      created_at text not null
    )`,

    `create unique index if not exists ux_moderation_bindings_provider
      on moderation_bindings (provider_id) where scope_type = 'provider'`,

    `create unique index if not exists ux_moderation_bindings_model
      on moderation_bindings (provider_id, model) where scope_type = 'model'`,

    `create table if not exists moderation_events (
      id integer primary key autoincrement,
      trace_id text not null,
      occurred_at text not null,
      stage text not null,
      categories text not null default '',
      detector_ids text not null default '',
      score real,
      matched text not null default '',
      action text not null default '',
      blocked integer not null default 0,
      ip text,
      policy_id integer,
      policy_name text,
      provider_name text,
      model text
    )`,

    `create index if not exists ix_moderation_events_occurred_at on moderation_events (occurred_at desc)`,
    `create index if not exists ix_moderation_events_stage on moderation_events (stage)`,
    `create index if not exists ix_moderation_events_blocked on moderation_events (blocked)`,
  ],
};
