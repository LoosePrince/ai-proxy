/**
 * 文本归一化 —— 对抗低成本混淆（零宽字符、全角、leet、插入标点/空格）。
 *
 * 纯函数，无 IO，可单测。归一化只用于**匹配**，不改变回传给客户端的内容。
 */

/** 常被用来切断关键词的不可见字符与控制符 */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

/** leet / 同形字替换表。只映射到单个 ASCII 字母，保持长度以便定位。 */
const LEET_MAP: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '!': 'i',
  '|': 'i',
  '3': 'e',
  '4': 'a',
  '@': 'a',
  '5': 's',
  $: 's',
  '7': 't',
  '+': 't',
  '8': 'b',
  '9': 'g',
  '2': 'z',
};

function mapLeet(char: string): string {
  return LEET_MAP[char] ?? char;
}

/** 基础归一化：Unicode NFKC、去掉不可见字符、统一小写与空白 */
export function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(INVISIBLE, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 归一化 + leet 还原：`sh1t` → `shit`。用于词表匹配的第二形态。
 * 标点保留原样（由 compact 负责去标点）。
 */
export function deLeet(value: string): string {
  let out = '';
  for (const char of value) out += mapLeet(char);
  return out;
}

/**
 * 去掉标点、符号与空白后的紧凑形态：`f u c k` → `fuck`。
 * 用于对抗插入空格/标点的拆词规避。
 */
export function compact(value: string): string {
  return value.replace(/[\p{P}\p{S}\s]+/gu, '');
}

export interface NormalizedForms {
  /** 原样归一化，保留词边界 */
  readable: string;
  /** leet 还原后的形态 */
  deLeeted: string;
  /** 去标点空白的紧凑形态 */
  compact: string;
  /** 紧凑 + leet 还原 */
  compactDeLeeted: string;
}

export function normalizeForms(value: string): NormalizedForms {
  const readable = normalizeText(value);
  const deLeeted = deLeet(readable);
  return {
    readable,
    deLeeted,
    compact: compact(readable),
    compactDeLeeted: compact(deLeeted),
  };
}
