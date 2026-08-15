/**
 * 006_prompt_and_behavior — 系统提示词与请求行为策略配置。
 */

export const migration006PromptAndBehavior = {
  id: '006_prompt_and_behavior',
  statements: [
    `alter table providers add column system_prompt text not null default ''`,
  ],
};