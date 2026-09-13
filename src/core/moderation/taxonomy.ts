/**
 * 内容审核类别体系（识别方向）。
 *
 * 类别是**契约**而不是配置：引擎、策略、审计表都引用同一套 id，
 * 新增类别必须改代码（旧数据里的未知类别会被忽略而不是报错）。
 *
 * 层级语义：子类别以 `父/子` 命名，并带 parent 指针。策略里**未显式出现**的
 * 类别继承祖先的启用状态（只配父类别等于启用整棵子树）；显式给出子类别的
 * enabled=false 又能单独关掉它。这个继承判定在 compile.ts 的 resolveCategories。
 */

import type { ModerationCategory } from '../../types/api';

export interface CategoryMeta {
  id: ModerationCategory;
  label: string;
  parent: ModerationCategory | null;
  /** 未在策略中显式配置时的默认敏感度 */
  defaultSensitivity: number;
}

export const MODERATION_CATEGORIES: readonly ModerationCategory[] = [
  'sexual',
  'sexual/minors',
  'harassment',
  'harassment/threatening',
  'hate',
  'hate/threatening',
  'self-harm',
  'self-harm/intent',
  'self-harm/instructions',
  'violence',
  'violence/graphic',
  'illicit',
  'illicit/violent',
  'profanity',
];

const META: Record<ModerationCategory, CategoryMeta> = {
  sexual: { id: 'sexual', label: '色情内容', parent: null, defaultSensitivity: 60 },
  'sexual/minors': { id: 'sexual/minors', label: '儿童性内容', parent: 'sexual', defaultSensitivity: 95 },
  harassment: { id: 'harassment', label: '骚扰', parent: null, defaultSensitivity: 50 },
  'harassment/threatening': { id: 'harassment/threatening', label: '威胁性骚扰', parent: 'harassment', defaultSensitivity: 80 },
  hate: { id: 'hate', label: '仇恨言论', parent: null, defaultSensitivity: 70 },
  'hate/threatening': { id: 'hate/threatening', label: '威胁性仇恨', parent: 'hate', defaultSensitivity: 85 },
  'self-harm': { id: 'self-harm', label: '自我伤害', parent: null, defaultSensitivity: 70 },
  'self-harm/intent': { id: 'self-harm/intent', label: '自我伤害意图', parent: 'self-harm', defaultSensitivity: 85 },
  'self-harm/instructions': {
    id: 'self-harm/instructions',
    label: '自我伤害方法',
    parent: 'self-harm',
    defaultSensitivity: 90,
  },
  violence: { id: 'violence', label: '暴力', parent: null, defaultSensitivity: 60 },
  'violence/graphic': { id: 'violence/graphic', label: '血腥暴力', parent: 'violence', defaultSensitivity: 80 },
  illicit: { id: 'illicit', label: '非法活动', parent: null, defaultSensitivity: 70 },
  'illicit/violent': { id: 'illicit/violent', label: '暴力犯罪', parent: 'illicit', defaultSensitivity: 85 },
  profanity: { id: 'profanity', label: '脏话/辱骂', parent: null, defaultSensitivity: 40 },
};

export function categoryMeta(category: ModerationCategory): CategoryMeta {
  return META[category];
}

export function isModerationCategory(value: unknown): value is ModerationCategory {
  return typeof value === 'string' && (MODERATION_CATEGORIES as readonly string[]).includes(value);
}

/** 类别自身 + 全部祖先（用于父类别启用时向下覆盖） */
export function categoryChain(category: ModerationCategory): ModerationCategory[] {
  const chain: ModerationCategory[] = [category];
  let parent = META[category].parent;
  while (parent) {
    chain.push(parent);
    parent = META[parent].parent;
  }
  return chain;
}

/**
 * 敏感度 → 命中阈值。敏感度越高阈值越低：100 → 0（任何命中都拦），
 * 0 → 0.99（几乎不拦）。命中分落在 [0,1]，1 表示高置信硬命中。
 */
export function sensitivityThreshold(sensitivity: number): number {
  const clamped = Number.isFinite(sensitivity) ? Math.min(100, Math.max(0, sensitivity)) : 50;
  return Math.min(0.99, Math.max(0, 1 - clamped / 100));
}

export function categoryLabel(category: ModerationCategory): string {
  return META[category].label;
}
