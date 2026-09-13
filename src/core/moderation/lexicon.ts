/**
 * 内置分类词库 —— 唯一负责**类别归属**的检测引擎。
 *
 * 设计取舍：第三方包（visulima / obscenity）只判断「是否命中违禁词」，
 * 不提供 sexual/minors、hate/threatening 这类细分类别。因此分类准确性
 * 完全取决于这里的词库质量，其余引擎只作为旁证（组合逻辑见 evaluate.ts）。
 *
 * 匹配策略：每个类别预编译三个正则 ——
 *   ascii      仅 ASCII 词条，带词边界，避免命中更长单词内部（Scunthorpe）
 *   substring  非 ASCII（中文等无空格语言）词条，做子串匹配
 *   compact    全部词条，用于去标点空白后的紧凑形态
 * 并对「原样 / leet 还原 / 紧凑 / 紧凑+leet」四种形态各跑一遍，
 * 抵抗插入空格标点与 leet 替换的规避。
 */

import type { ModerationCategory } from '../../types/api';
import { MODERATION_CATEGORIES } from './taxonomy';
import { normalizeForms, type NormalizedForms } from './normalize';

/**
 * 默认词库。拉丁词条尽量用完整拼写而不是子串，降低误伤；
 * 策略里的自定义违禁词会并入进来。
 */
export const DEFAULT_LEXICON: Partial<Record<ModerationCategory, string[]>> = {
  profanity: [
    'fuck', 'fucking', 'fucker', 'shit', 'bullshit', 'bitch', 'bastard', 'asshole', 'arsehole',
    'cunt', 'dickhead', 'motherfucker', 'whore', 'slut', 'wanker', 'twat', 'prick', 'crap',
    'piss', 'damn', '傻逼', '傻b', '妈的', '操你', '去死', '贱人', '滚蛋', '狗东西',
  ],
  sexual: [
    'porn', 'porno', 'pornography', 'pornographic', 'nsfw', 'blowjob', 'handjob', 'masturbate',
    'masturbation', 'orgasm', 'genital', 'genitalia', 'vagina', 'penis', 'anal sex', 'hentai',
    'cumshot', 'nude photo', 'nudes', 'sexual intercourse', '色情', '裸照', '黄片', '做爱',
    '性交', '淫秽', '淫乱', '口交', '肛门',
  ],
  'sexual/minors': [
    'child porn', 'childporn', 'child pornography', 'pedo', 'pedophile', 'paedophile', 'lolicon',
    'loli', 'underage sex', 'minor sex', 'child sex', '儿童色情', '幼女', '萝莉', '未成年性',
    '未成年裸照',
  ],
  harassment: [
    'idiot', 'moron', 'imbecile', 'dumbass', 'loser', 'retard', 'retarded', 'worthless piece',
    '废物', '垃圾东西', '蠢货', '弱智', '脑残', '笨蛋', '没用的东西',
  ],
  'harassment/threatening': [
    'i will kill you', 'i will hurt you', 'you will regret', 'watch your back', '我要杀了你',
    '弄死你', '打死你', '你死定了', '等着报复',
  ],
  hate: [
    'nigger', 'nigga', 'kike', 'spic', 'chink', 'wetback', 'white power', 'ethnic cleansing',
    'heil hitler', 'nazi', 'supremacist', '种族歧视', '纳粹', '支那', '东亚病夫',
  ],
  'hate/threatening': ['kill all', 'death to', 'gas the', 'exterminate', '杀光', '灭绝', '清洗掉'],
  'self-harm': [
    'suicide', 'suicidal', 'kill myself', 'killing myself', 'self harm', 'self-harm', 'self harming',
    'cutting myself', 'suicide note', '自杀', '自残', '割腕', '轻生',
  ],
  'self-harm/intent': [
    'i want to die', 'i wanna die', 'want to kill myself', 'end my life', 'better off dead',
    '我想死', '不想活了', '想结束生命', '活着没意义',
  ],
  'self-harm/instructions': [
    'how to kill myself', 'suicide method', 'ways to kill myself', 'how to commit suicide',
    'painless suicide', '自杀方法', '怎么自杀', '如何自杀', '安乐死方法',
  ],
  violence: [
    'kill him', 'kill her', 'kill them', 'murder', 'shoot', 'stab', 'bomb', 'massacre', 'assassinate',
    '杀人', '谋杀', '爆炸', '枪击', '砍死', '袭击',
  ],
  'violence/graphic': [
    'gore', 'behead', 'decapitate', 'dismember', 'mutilate', 'disembowel', 'blood splatter',
    '血腥', '分尸', '肢解', '开膛', '碎尸',
  ],
  illicit: [
    'cocaine', 'heroin', 'methamphetamine', 'fentanyl', 'money laundering', 'credit card fraud',
    'insider trading', '毒品', '冰毒', '海洛因', '洗钱', '诈骗', '伪造证件',
  ],
  'illicit/violent': [
    'human trafficking', 'kidnap', 'kidnapping', 'assassination', 'contract killing',
    '绑架', '拐卖', '雇佣杀人', '买凶',
  ],
};

const ASCII_TERM = /^[\x20-\x7e]+$/;

interface CompiledTerms {
  ascii: RegExp | null;
  substring: RegExp | null;
  compact: RegExp | null;
  terms: Set<string>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTerm(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function buildRegex(list: string[], boundary: boolean): RegExp | null {
  if (list.length === 0) return null;
  // 长词条优先，避免短词条抢先匹配导致命中片段失真
  const alternatives = [...list].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  const source = boundary
    ? `(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`
    : `(?:${alternatives})`;
  return new RegExp(source, 'gu');
}

function compileTerms(rawTerms: string[]): CompiledTerms {
  const terms = new Set<string>();
  const ascii: string[] = [];
  const substring: string[] = [];

  for (const raw of rawTerms) {
    const term = normalizeTerm(raw);
    if (!term) continue;
    terms.add(term);
    if (ASCII_TERM.test(term)) ascii.push(term);
    else substring.push(term);
  }

  const all = [...terms];
  return {
    ascii: buildRegex(ascii, true),
    substring: buildRegex(substring, false),
    compact: buildRegex(all, false),
    terms,
  };
}

const DEFAULT_COMPILED = new Map<ModerationCategory, CompiledTerms>();
for (const category of MODERATION_CATEGORIES) {
  const terms = DEFAULT_LEXICON[category];
  if (terms && terms.length > 0) DEFAULT_COMPILED.set(category, compileTerms(terms));
}

const CUSTOM_CACHE_LIMIT = 32;
const customCache = new Map<string, CompiledTerms>();

function compiledCustom(keywords: string[]): CompiledTerms {
  const key = keywords.join('\u0000');
  const cached = customCache.get(key);
  if (cached) return cached;

  const compiled = compileTerms(keywords);
  if (customCache.size >= CUSTOM_CACHE_LIMIT) {
    const oldest = customCache.keys().next().value;
    if (oldest !== undefined) customCache.delete(oldest);
  }
  customCache.set(key, compiled);
  return compiled;
}

/** 在四种形态上跑正则，返回去重后的命中词条 */
function collectMatches(compiled: CompiledTerms, forms: NormalizedForms): string[] {
  const found = new Set<string>();

  const scan = (text: string, pattern: RegExp | null): void => {
    if (!pattern || !text) return;
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const hit = match[0]?.toLowerCase();
      if (hit && compiled.terms.has(hit)) found.add(hit);
    }
  };

  for (const text of [forms.readable, forms.deLeeted]) {
    scan(text, compiled.ascii);
    scan(text, compiled.substring);
  }
  for (const text of [forms.compact, forms.compactDeLeeted]) {
    scan(text, compiled.compact);
  }

  return [...found];
}

/** 命中次数 → 置信分：1 次 0.5，2 次 0.75，3 次 0.875，收敛到 1 */
export function scoreFromMatchCount(count: number): number {
  if (count <= 0) return 0;
  return 1 - 0.5 ** count;
}

export interface LexiconScanResult {
  categories: Map<ModerationCategory, string[]>;
  customMatches: string[];
}

/**
 * 扫描文本，返回每个类别的命中词条。
 * 只扫描 enabledCategories，避免无关类别的正则开销。
 */
export function scanLexicon(
  text: string,
  enabledCategories: ModerationCategory[],
  customKeywords: string[],
): LexiconScanResult {
  const forms = normalizeForms(text);
  const categories = new Map<ModerationCategory, string[]>();

  for (const category of enabledCategories) {
    const compiled = DEFAULT_COMPILED.get(category);
    if (!compiled) continue;
    const matched = collectMatches(compiled, forms);
    if (matched.length > 0) categories.set(category, matched);
  }

  const customMatches =
    customKeywords.length > 0 ? collectMatches(compiledCustom(customKeywords), forms) : [];

  return { categories, customMatches };
}
