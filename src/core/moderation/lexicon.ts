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
      const hit = normalizeTerm(match[0] ?? '');
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
 * 只扫描自定义违禁词（enabledCategories 用于归类）。
 */
export function scanLexicon(
  text: string,
  enabledCategories: ModerationCategory[],
  customKeywords: string[],
): LexiconScanResult {
  const forms = normalizeForms(text);
  const categories = new Map<ModerationCategory, string[]>();

  const customMatches =
    customKeywords.length > 0 ? collectMatches(compiledCustom(customKeywords), forms) : [];

  return { categories, customMatches };
}
