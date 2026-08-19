/** 009_provider_script_runtime — Provider 主入口与变量运行时配置。 */

export const migration009ProviderScriptRuntime = {
  id: '009_provider_script_runtime',
  statements: [
    `alter table providers add column variables_auto_sync integer not null default 0`,
    `alter table providers add column main_script text not null default ''`,
    `alter table providers add column schedule_enabled integer not null default 0`,
    `alter table providers add column schedule_cron text not null default ''`,
    `alter table providers add column last_run_at text`,
    `alter table providers add column last_run_ok integer`,
    `alter table providers add column last_run_error text`,
    `alter table providers add column variables_updated_at text`,
  ],
};