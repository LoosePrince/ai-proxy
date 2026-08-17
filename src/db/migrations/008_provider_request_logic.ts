/** 008_provider_request_logic — Provider 自定义请求执行配置。 */

export const migration008ProviderRequestLogic = {
  id: '008_provider_request_logic',
  statements: [
    `alter table providers add column request_mode text not null default 'openai'`,
    `alter table providers add column request_script text not null default ''`,
    `alter table providers add column variables_json text not null default '[]'`,
  ],
};