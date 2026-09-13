/**
 * 审核判定 —— 运行启用的引擎并按 combineMode 组合。
 *
 * 组合语义（对应「要求通过所有库的检测」）：
 *   strict    任一启用引擎命中即拦截 —— 每个引擎都必须放行
 *   majority  超过半数启用引擎命中才拦截
 *   lenient   全部启用引擎都命中才拦截
 *
 * 「启用引擎」指策略里 enabled 且 isAvailable() 为 true 的引擎；
 * 未安装的第三方库不算入分母，否则 strict 会被未安装的库架空、lenient 永远不触发。
 */

import type { ModerationCategory, ModerationStage } from '../../types/api';
import { detectorById, MODERATION_DETECTORS } from './detectors';
import type {
  CompiledModerationPolicy,
  DetectorContext,
  DetectorFinding,
  ModerationDecision,
} from './types';
import { emptyDecision } from './types';

const MAX_MATCHED_ITEMS = 12;
const MAX_MATCHED_CHARS = 60;

/** 命中片段脱敏：截断长度并限量，避免审计表被超长正文撑爆 */
function limitMatched(values: string[]): string[] {
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return unique.slice(0, MAX_MATCHED_ITEMS).map((value) =>
    value.length > MAX_MATCHED_CHARS ? `${value.slice(0, MAX_MATCHED_CHARS)}…` : value,
  );
}

interface DetectorOutcome {
  detectorId: string;
  hit: boolean;
  categories: ModerationCategory[];
  score: number;
  matched: string[];
}

function runDetector(
  detectorId: string,
  text: string,
  policy: CompiledModerationPolicy,
): DetectorOutcome | null {
  const adapter = detectorById(detectorId);
  if (!adapter) return null;

  let available = false;
  try {
    available = adapter.isAvailable();
  } catch {
    available = false;
  }
  if (!available) return null;

  const enabledCategories = [...policy.categories.keys()];
  const context: DetectorContext = {
    enabledCategories,
    attributeCategories: policy.detectors.find((entry) => entry.detectorId === detectorId)?.categories ?? [],
    customKeywords: policy.customKeywords,
  };

  let findings: DetectorFinding[] = [];
  try {
    findings = adapter.inspect(text, context) ?? [];
  } catch {
    return null;
  }

  const categories = new Set<ModerationCategory>();
  const matched: string[] = [];
  let score = 0;
  let hit = false;

  for (const finding of findings) {
    const setting = policy.categories.get(finding.category);
    if (!setting || finding.score < setting.threshold) continue;
    hit = true;
    categories.add(finding.category);
    matched.push(...finding.matched);
    score = Math.max(score, finding.score);
  }

  return { detectorId, hit, categories: [...categories], score, matched: limitMatched(matched) };
}

/**
 * 组合判定：total 为「启用且可用」的引擎数。
 * 抽成纯函数便于单测三种模式与边界（无可用引擎永远不拦）。
 */
export function combineDecision(
  mode: CompiledModerationPolicy['combineMode'],
  hits: number,
  total: number,
): boolean {
  if (total <= 0) return false;
  if (mode === 'strict') return hits >= 1;
  if (mode === 'majority') return hits * 2 > total;
  return hits === total;
}

export function evaluateText(
  text: string,
  policy: CompiledModerationPolicy,
  stage: ModerationStage,
): ModerationDecision {
  const decision = emptyDecision(stage);
  if (!text || policy.categories.size === 0) return decision;

  const outcomes: DetectorOutcome[] = [];
  for (const detector of policy.detectors) {
    const outcome = runDetector(detector.detectorId, text, policy);
    if (outcome) outcomes.push(outcome);
  }

  const total = outcomes.length;
  if (total === 0) return decision;

  const hits = outcomes.filter((outcome) => outcome.hit);
  if (!combineDecision(policy.combineMode, hits.length, total)) return decision;

  const categories = new Set<ModerationCategory>();
  const matched: string[] = [];
  let score = 0;
  for (const outcome of hits) {
    for (const category of outcome.categories) categories.add(category);
    matched.push(...outcome.matched);
    score = Math.max(score, outcome.score);
  }

  return {
    blocked: true,
    stage,
    categories: [...categories],
    detectorIds: hits.map((outcome) => outcome.detectorId),
    score,
    matched: limitMatched(matched),
    action: stage === 'input' ? policy.action : policy.outputAction,
    policyId: policy.id,
    policyName: policy.name,
  };
}

/** 供后台展示：注册表里所有引擎（含未安装） */
export function registeredDetectorIds(): string[] {
  return MODERATION_DETECTORS.map((detector) => detector.id);
}
