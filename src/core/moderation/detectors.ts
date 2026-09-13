/**
 * 可插拔检测引擎注册表。
 *
 * 每个引擎都实现 ModerationDetector：同步、离线、内部吞异常。
 * 第三方包（visulima / whitz / obscenity）通过懒加载接入：未安装时
 * isAvailable() 返回 false，策略里勾选它也只是被跳过，绝不会让服务启动失败。
 *
 * 类别归属：
 *   builtin-lexicon / whitz  —— 原生分类（词条自带 category）
 *   visulima / obscenity     —— 通用命中，归入策略为该引擎配置的 attributeCategories
 */

import { createRequire } from 'node:module';

import type { ModerationCategory, ModerationDetectorInfoDTO } from '../../types/api';
import { MODERATION_CATEGORIES } from './taxonomy';
import { DEFAULT_LEXICON, scanLexicon, scoreFromMatchCount } from './lexicon';
import type { DetectorContext, DetectorFinding, ModerationDetector } from './types';

/* ------------------------------------------------------------------ 懒加载 */

const req = createRequire(__filename);

function tryLoad<T>(id: string): T | null {
  try {
    return req(id) as T;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------- builtin-lexicon */

const lexiconDetector: ModerationDetector = {
  id: 'builtin-lexicon',
  label: '内置分类词库',
  description: '随服务内置的分类违禁词 + 自定义违禁词，是唯一按类别归属的引擎，支持 leet 与插入标点规避。',
  nativeCategories: true,
  categories: 'all',
  languages: ['zh', 'en'],
  isAvailable: () => true,
  inspect(text, context) {
    const { categories, customMatches } = scanLexicon(text, context.enabledCategories, context.customKeywords);
    const findings: DetectorFinding[] = [];

    for (const [category, matched] of categories) {
      findings.push({ category, score: scoreFromMatchCount(matched.length), matched });
    }

    if (customMatches.length > 0 && context.enabledCategories.length > 0) {
      // 自定义违禁词没有类别语义：优先归入 profanity，未启用则归入全部启用类别
      const targets = context.enabledCategories.includes('profanity')
        ? (['profanity'] as ModerationCategory[])
        : context.enabledCategories;
      const score = Math.max(scoreFromMatchCount(customMatches.length), 0.9);
      for (const category of targets) findings.push({ category, score, matched: customMatches });
    }

    return findings;
  },
};

/* ------------------------------------------------------------------ whitz */

interface WhitzMatch {
  word: string;
  normalized: string;
  category?: string;
  severity: number;
  confidence: number;
}

interface WhitzDetector {
  loadWords(entries: Array<{ word: string; category?: string; severity?: number }>): void;
  analyze(content: string): { flagged: boolean; matches: WhitzMatch[] };
}

interface WhitzModule {
  NodeWordDetector: new (config?: Record<string, unknown>) => WhitzDetector;
}

const whitzModule = tryLoad<WhitzModule>('whitz-word-detector');

/** whitz 需要先把词条灌进去，词条随自定义违禁词变化，因此按签名缓存实例 */
const WHITZ_CACHE_LIMIT = 8;
const whitzCache = new Map<string, WhitzDetector | null>();

function whitzEntries(customKeywords: string[]): Array<{ word: string; category: string; severity: number }> {
  const entries: Array<{ word: string; category: string; severity: number }> = [];
  for (const category of MODERATION_CATEGORIES) {
    const terms = DEFAULT_LEXICON[category];
    if (!terms) continue;
    const severity = MODERATION_CATEGORIES.length - MODERATION_CATEGORIES.indexOf(category);
    for (const word of terms) entries.push({ word, category, severity });
  }
  for (const word of customKeywords) entries.push({ word, category: 'profanity', severity: 100 });
  return entries;
}

function whitzDetectorFor(customKeywords: string[]): WhitzDetector | null {
  if (!whitzModule) return null;
  const key = customKeywords.join('\u0000');
  const cached = whitzCache.get(key);
  if (cached !== undefined) return cached;

  let detector: WhitzDetector | null = null;
  try {
    detector = new whitzModule.NodeWordDetector({
      enableFuzzy: true,
      maxLevenshteinDistance: 1,
      minWordLength: 3,
      enableJoinedScan: true,
    });
    detector.loadWords(whitzEntries(customKeywords));
  } catch {
    detector = null;
  }

  if (whitzCache.size >= WHITZ_CACHE_LIMIT) {
    const oldest = whitzCache.keys().next().value;
    if (oldest !== undefined) whitzCache.delete(oldest);
  }
  whitzCache.set(key, detector);
  return detector;
}

const whitzAdapter: ModerationDetector = {
  id: 'whitz',
  label: 'whitz-word-detector',
  description: '模糊匹配引擎：把内置词库灌入后提供 leet / 同形字 / 近似拼写容忍，自带类别归属。',
  nativeCategories: true,
  categories: 'all',
  languages: ['zh', 'en'],
  isAvailable: () => !!whitzModule,
  inspect(text, context) {
    const detector = whitzDetectorFor(context.customKeywords);
    if (!detector) return [];

    let matches: WhitzMatch[] = [];
    try {
      matches = detector.analyze(text).matches ?? [];
    } catch {
      return [];
    }

    const byCategory = new Map<ModerationCategory, { matched: string[]; confidence: number }>();
    for (const match of matches) {
      const category = match.category as ModerationCategory | undefined;
      if (!category || !context.enabledCategories.includes(category)) continue;
      const entry = byCategory.get(category) ?? { matched: [], confidence: 0 };
      entry.matched.push(match.word);
      entry.confidence = Math.max(entry.confidence, Number(match.confidence) || 0.5);
      byCategory.set(category, entry);
    }

    return [...byCategory].map(([category, entry]) => ({
      category,
      score: Math.max(entry.confidence, scoreFromMatchCount(entry.matched.length)),
      matched: [...new Set(entry.matched)],
    }));
  },
};

/* --------------------------------------------------------------- visulima */

interface VisulimaMatch {
  word: string;
  language: string;
  category?: string;
}

interface VisulimaChecker {
  check(text: string, options?: { languages?: readonly string[] }): { matches: VisulimaMatch[] };
}

interface VisulimaModule {
  /** 内置的 19 语言违禁词库，按语言分组 */
  BANNED_WORDS: Record<string, readonly unknown[]>;
  createChecker(options?: { words?: Record<string, readonly unknown[]>; allowlist?: readonly string[] }): VisulimaChecker;
}

const visulimaModule = tryLoad<VisulimaModule>('@visulima/content-safety');

/**
 * 关键：`createChecker({ words })` 会用传入字典**替换**内置词库。
 * 因此无自定义词时必须调用 createChecker()，有自定义词时必须把内置词库一起带上。
 */
function safeChecker(mod: VisulimaModule, customKeywords: string[]): VisulimaChecker | null {
  try {
    if (customKeywords.length === 0) return mod.createChecker();
    return mod.createChecker({ words: { ...mod.BANNED_WORDS, custom: customKeywords } });
  } catch {
    return null;
  }
}

const VISULIMA_CACHE_LIMIT = 8;
const visulimaCache = new Map<string, VisulimaChecker | null>();
let visulimaDefault: VisulimaChecker | null | undefined;

function visulimaCheckerFor(customKeywords: string[]): VisulimaChecker | null {
  if (!visulimaModule) return null;
  if (customKeywords.length === 0) {
    if (visulimaDefault === undefined) visulimaDefault = safeChecker(visulimaModule, []);
    return visulimaDefault;
  }
  const key = customKeywords.join('\u0000');
  const cached = visulimaCache.get(key);
  if (cached !== undefined) return cached;
  const checker = safeChecker(visulimaModule, customKeywords);
  if (visulimaCache.size >= VISULIMA_CACHE_LIMIT) {
    const oldest = visulimaCache.keys().next().value;
    if (oldest !== undefined) visulimaCache.delete(oldest);
  }
  visulimaCache.set(key, checker);
  return checker;
}

const visulimaAdapter: ModerationDetector = {
  id: 'visulima',
  label: '@visulima/content-safety',
  description: '19 种语言的内置违禁词库，词边界匹配；命中不带类别，按策略配置归属到指定类别。',
  nativeCategories: false,
  categories: 'all',
  languages: ['en', 'de', 'fr', 'es', 'ja', 'ko', 'zh', 'ru', 'pt', 'it', 'pl', 'ar', 'hi'],
  isAvailable: () => !!visulimaModule,
  inspect(text, context) {
    const checker = visulimaCheckerFor(context.customKeywords);
    if (!checker) return [];

    let matches: VisulimaMatch[] = [];
    try {
      matches = checker.check(text).matches ?? [];
    } catch {
      return [];
    }
    if (matches.length === 0) return [];

    const matched = [...new Set(matches.map((match) => match.word))];
    const score = scoreFromMatchCount(matched.length);
    return attributeGeneric(context, score, matched);
  },
};

/* --------------------------------------------------------------- obscenity */

interface ObscenityMatch {
  startIndex: number;
  endIndex: number;
  matchLength: number;
}

interface ObscenityMatcher {
  getAllMatches(input: string): ObscenityMatch[];
}

interface ObscenityModule {
  RegExpMatcher: new (options: unknown) => ObscenityMatcher;
  englishDataset: { build(): unknown };
  englishRecommendedTransformers: unknown;
}

const obscenityModule = tryLoad<ObscenityModule>('obscenity');

/** obscenity 的 regexp 匹配器构建成本高，构建一次长期复用 */
let obscenityMatcher: ObscenityMatcher | null = null;
function getObscenityMatcher(): ObscenityMatcher | null {
  if (!obscenityModule) return null;
  if (obscenityMatcher) return obscenityMatcher;
  try {
    obscenityMatcher = new obscenityModule.RegExpMatcher({
      ...(obscenityModule.englishDataset.build() as object),
      ...(obscenityModule.englishRecommendedTransformers as object),
    });
  } catch {
    obscenityMatcher = null;
  }
  return obscenityMatcher;
}

const obscenityAdapter: ModerationDetector = {
  id: 'obscenity',
  label: 'obscenity',
  description: '英文脏话稳健匹配器，内置 confusable / leetspeak / 重复字符变换；命中不带类别。',
  nativeCategories: false,
  categories: ['profanity', 'harassment', 'hate'],
  languages: ['en'],
  isAvailable: () => !!obscenityModule,
  inspect(text, context) {
    const matcher = getObscenityMatcher();
    if (!matcher) return [];

    let matches: ObscenityMatch[] = [];
    try {
      matches = matcher.getAllMatches(text);
    } catch {
      return [];
    }
    if (matches.length === 0) return [];

    const score = scoreFromMatchCount(matches.length);
    return attributeGeneric(context, score, [`${matches.length} matched term(s)`]);
  },
};

/** 通用命中：为每个归属类别产出一条相同分数的 finding */
function attributeGeneric(context: DetectorContext, score: number, matched: string[]): DetectorFinding[] {
  const targets = context.attributeCategories.filter((category) => context.enabledCategories.includes(category));
  return targets.map((category) => ({ category, score, matched }));
}

/* --------------------------------------------------------------- 注册表 */

export const MODERATION_DETECTORS: readonly ModerationDetector[] = [
  lexiconDetector,
  whitzAdapter,
  visulimaAdapter,
  obscenityAdapter,
];

const DETECTOR_BY_ID = new Map(MODERATION_DETECTORS.map((detector) => [detector.id, detector]));

export function detectorById(id: string): ModerationDetector | undefined {
  return DETECTOR_BY_ID.get(id);
}

export function listDetectorInfo(): ModerationDetectorInfoDTO[] {
  return MODERATION_DETECTORS.map((detector) => ({
    id: detector.id,
    label: detector.label,
    description: detector.description,
    available: safeAvailable(detector),
    nativeCategories: detector.nativeCategories,
    categories: detector.categories,
    languages: detector.languages,
  }));
}

function safeAvailable(detector: ModerationDetector): boolean {
  try {
    return detector.isAvailable();
  } catch {
    return false;
  }
}
