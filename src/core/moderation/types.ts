/**
 * 内容审核核心类型 —— 纯函数层，不依赖 DB 与 HTTP。
 *
 * 这一层的输入是「已编译策略」（CompiledModerationPolicy），而不是原始 DTO：
 * 编译发生在配置快照构建时，热路径只做内存查表与词表匹配，零 DB 往返。
 */

import type {
  MaliciousBehaviorAction,
  ModerationCategory,
  ModerationCombineMode,
  ModerationOutputAction,
  ModerationStage,
} from '../../types/api';

/** 单个类别的生效阈值 */
export interface CompiledCategory {
  category: ModerationCategory;
  threshold: number;
}

/** 单个引擎的生效配置 */
export interface CompiledDetector {
  detectorId: string;
  /** 非原生分类引擎的通用命中归属类别 */
  categories: ModerationCategory[];
}

export interface CompiledModerationPolicy {
  id: number | null;
  name: string;
  /** 启用的类别 → 阈值；未出现在 map 中的类别视为关闭 */
  categories: Map<ModerationCategory, CompiledCategory>;
  detectors: CompiledDetector[];
  combineMode: ModerationCombineMode;
  action: MaliciousBehaviorAction;
  outputAction: ModerationOutputAction;
  outputResponse: string;
  response: string;
  holdBackChars: number;
  /** 自定义违禁词（已按行/逗号拆分） */
  customKeywords: string[];
}

export interface DetectorContext {
  /** 策略启用的类别；引擎可据此跳过无关类别 */
  enabledCategories: ModerationCategory[];
  /** 通用命中归属类别（针对 nativeCategories=false 的引擎） */
  attributeCategories: ModerationCategory[];
  /** 自定义违禁词，builtin-lexicon 与 whitz 会并入词表 */
  customKeywords: string[];
}

export interface DetectorFinding {
  category: ModerationCategory;
  /** 0..1 的置信分，1 表示确定命中 */
  score: number;
  /** 命中片段（未脱敏，调用方负责脱敏与截断） */
  matched: string[];
}

export interface ModerationDetector {
  id: string;
  label: string;
  description: string;
  /** true 表示引擎自己输出类别；false 表示命中统一归入 attributeCategories */
  nativeCategories: boolean;
  categories: ModerationCategory[] | 'all';
  languages: string[];
  /** 依赖是否已安装且可加载 */
  isAvailable(): boolean;
  /** 同步扫描；引擎内部异常必须自行吞掉，绝不能中断请求 */
  inspect(text: string, context: DetectorContext): DetectorFinding[];
}

/** 一次审核判定的结果 */
export interface ModerationDecision {
  blocked: boolean;
  stage: ModerationStage;
  categories: ModerationCategory[];
  detectorIds: string[];
  score: number;
  matched: string[];
  action: MaliciousBehaviorAction | ModerationOutputAction;
  policyId: number | null;
  policyName: string;
}

export function emptyDecision(stage: ModerationStage): ModerationDecision {
  return {
    blocked: false,
    stage,
    categories: [],
    detectorIds: [],
    score: 0,
    matched: [],
    action: 'empty',
    policyId: null,
    policyName: '',
  };
}
