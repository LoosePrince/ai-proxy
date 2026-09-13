/**
 * 策略编译与作用域解析 —— 纯函数。
 *
 * 编译发生在配置快照构建时：把 DTO 转成热路径可直接使用的
 * CompiledModerationPolicy（阈值已算好、类别已收敛成 Map）。
 * 热路径只做 resolve（内存查表），零 DB 往返、零重复计算。
 *
 * 作用域层级：模型级 > Provider 级 > 全局默认。
 */

import type {
  ModerationCategory,
  ModerationCategorySettingDTO,
  ModerationCombineMode,
  ModerationOutputAction,
  ModerationPolicyDTO,
} from '../../types/api';
import { MODERATION_CATEGORIES, categoryMeta, sensitivityThreshold } from './taxonomy';
import { detectorById } from './detectors';
import type { CompiledDetector, CompiledModerationPolicy } from './types';

export interface ModerationBindingRecord {
  scopeType: 'provider' | 'model';
  providerId: number | null;
  model: string | null;
  policyId: number;
}

export interface ModerationConfig {
  defaultPolicy: CompiledModerationPolicy | null;
  providerPolicies: Map<number, CompiledModerationPolicy>;
  /** key 为 `${providerId}:${model.toLowerCase()}` */
  modelPolicies: Map<string, CompiledModerationPolicy>;
  /** 已编译策略按 id 索引，便于审计里回填策略名 */
  byId: Map<number, CompiledModerationPolicy>;
}

export const EMPTY_MODERATION_CONFIG: ModerationConfig = {
  defaultPolicy: null,
  providerPolicies: new Map(),
  modelPolicies: new Map(),
  byId: new Map(),
};

function clampSensitivity(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 50;
  return Math.min(100, Math.max(0, Math.round(num)));
}

const COMBINE_MODES: readonly ModerationCombineMode[] = ['strict', 'majority', 'lenient'];
const OUTPUT_ACTIONS: readonly ModerationOutputAction[] = ['empty', 'error', 'response'];

export function parseModerationKeywords(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 类别生效判定：DTO 中显式出现的类别以自身 enabled 为准；
 * 未出现的类别继承祖先的启用状态。这样「只传父类别」等于启用整棵子树，
 * 而显式给子类别 enabled=false 又能单独关掉它。
 */
function resolveCategories(settings: ModerationCategorySettingDTO[]): Map<ModerationCategory, number> {
  const explicit = new Map<ModerationCategory, ModerationCategorySettingDTO>();
  for (const setting of settings) {
    if (MODERATION_CATEGORIES.includes(setting.category)) explicit.set(setting.category, setting);
  }

  const active = new Map<ModerationCategory, number>();

  const isEnabled = (category: ModerationCategory): { enabled: boolean; sensitivity: number } => {
    const setting = explicit.get(category);
    if (setting) return { enabled: setting.enabled, sensitivity: clampSensitivity(setting.sensitivity) };

    const parent = categoryMeta(category).parent;
    if (parent) {
      const inherited = isEnabled(parent);
      if (inherited.enabled) return { enabled: true, sensitivity: inherited.sensitivity };
    }
    return { enabled: false, sensitivity: categoryMeta(category).defaultSensitivity };
  };

  for (const category of MODERATION_CATEGORIES) {
    const state = isEnabled(category);
    if (state.enabled) active.set(category, state.sensitivity);
  }

  return active;
}

/**
 * 把（可能不完整的）类别配置展开成全部类别的显式配置。
 * 存储与后台展示都依赖它：未提供的子类别继承父类别状态，
 * 未提供且无启用祖先的类别按默认敏感度关闭。
 */
export function materializeCategorySettings(
  settings: ModerationCategorySettingDTO[],
): ModerationCategorySettingDTO[] {
  const explicit = new Map<ModerationCategory, ModerationCategorySettingDTO>();
  for (const setting of settings) {
    if (MODERATION_CATEGORIES.includes(setting.category)) explicit.set(setting.category, setting);
  }

  const resolved = new Map<ModerationCategory, { enabled: boolean; sensitivity: number }>();
  const resolve = (category: ModerationCategory): { enabled: boolean; sensitivity: number } => {
    const cached = resolved.get(category);
    if (cached) return cached;

    const own = explicit.get(category);
    const parent = categoryMeta(category).parent;
    const inherited = parent ? resolve(parent) : null;

    const value = own
      ? { enabled: own.enabled, sensitivity: clampSensitivity(own.sensitivity) }
      : inherited && inherited.enabled
        ? { enabled: true, sensitivity: inherited.sensitivity }
        : { enabled: false, sensitivity: categoryMeta(category).defaultSensitivity };

    resolved.set(category, value);
    return value;
  };

  return MODERATION_CATEGORIES.map((category) => {
    const value = resolve(category);
    return { category, enabled: value.enabled, sensitivity: value.sensitivity };
  });
}

export function compilePolicy(dto: ModerationPolicyDTO): CompiledModerationPolicy {
  const sensitivityByCategory = resolveCategories(dto.categories);
  const categories = new Map<ModerationCategory, { category: ModerationCategory; threshold: number }>();
  for (const [category, sensitivity] of sensitivityByCategory) {
    categories.set(category, { category, threshold: sensitivityThreshold(sensitivity) });
  }

  const detectors: CompiledDetector[] = [];
  for (const setting of dto.detectors) {
    if (!setting.enabled) continue;
    if (!detectorById(setting.detectorId)) continue;
    const mapped = (setting.categories ?? []).filter((category) => MODERATION_CATEGORIES.includes(category));
    detectors.push({ detectorId: setting.detectorId, categories: mapped });
  }

  return {
    id: dto.id ?? null,
    name: dto.name,
    categories,
    detectors,
    combineMode: COMBINE_MODES.includes(dto.combineMode) ? dto.combineMode : 'strict',
    action: dto.action,
    outputAction: OUTPUT_ACTIONS.includes(dto.outputAction) ? dto.outputAction : 'empty',
    outputResponse: dto.outputResponse ?? '',
    response: dto.response ?? '',
    holdBackChars: Math.min(2000, Math.max(0, Math.round(Number(dto.holdBackChars) || 0))),
    customKeywords: parseModerationKeywords(dto.forbiddenKeywords),
  };
}

/**
 * 编译全部策略与绑定。
 * 只有 enabled 的策略会进入解析表；绑定指向已停用/已删除策略时静默忽略，
 * 请求会退回上一层（Provider → 全局默认），而不是直接放行。
 */
export function compileModerationConfig(
  policies: ModerationPolicyDTO[],
  bindings: ModerationBindingRecord[],
): ModerationConfig {
  const byId = new Map<number, CompiledModerationPolicy>();
  let defaultPolicy: CompiledModerationPolicy | null = null;

  for (const dto of policies) {
    if (!dto.enabled) continue;
    const compiled = compilePolicy(dto);
    byId.set(dto.id, compiled);
    if (dto.isDefault) defaultPolicy = compiled;
  }

  const providerPolicies = new Map<number, CompiledModerationPolicy>();
  const modelPolicies = new Map<string, CompiledModerationPolicy>();

  for (const binding of bindings) {
    const policy = byId.get(binding.policyId);
    if (!policy) continue;
    if (binding.scopeType === 'provider' && binding.providerId !== null) {
      providerPolicies.set(binding.providerId, policy);
    } else if (binding.scopeType === 'model' && binding.providerId !== null && binding.model) {
      modelPolicies.set(`${binding.providerId}:${binding.model.toLowerCase()}`, policy);
    }
  }

  return { defaultPolicy, providerPolicies, modelPolicies, byId };
}

/** 按作用域解析生效策略：模型级 > Provider 级 > 全局默认 */
export function resolveModerationPolicy(
  config: ModerationConfig,
  providerId: number | null,
  model: string | null,
): CompiledModerationPolicy | null {
  if (providerId !== null && model) {
    const byModel = config.modelPolicies.get(`${providerId}:${model.toLowerCase()}`);
    if (byModel) return byModel;
  }
  if (providerId !== null) {
    const byProvider = config.providerPolicies.get(providerId);
    if (byProvider) return byProvider;
  }
  return config.defaultPolicy;
}
