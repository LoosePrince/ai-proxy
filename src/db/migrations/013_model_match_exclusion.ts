/** 013 —— Provider / 模型 不参与模型 id 匹配。 */

export const migration013ModelMatchExclusion = {
  id: '013_model_match_exclusion',
  statements: [
    `alter table providers add column exclude_from_model_matching integer not null default 0`,
    `alter table providers add column model_match_exclude_json text not null default '[]'`,
  ],
};