import type { JsonRecord } from './protocol';

const MAX_SCAN_TEXT = 200_000;
const MALICIOUS_THRESHOLD = 5;
const IDE_THRESHOLD = 5;

type TextCorpus = {
  readable: string;
  compact: string;
};

type Signal = {
  weight: number;
  patterns: RegExp[];
};

const IDE_SIGNALS: Signal[] = [
  {
    weight: 5,
    patterns: [
      /\b(cursor|vscode|visual studio code|windsurf|jetbrains|zed editor|claude code|open code|github copilot|openai codex|cline|roo code|continue\.dev|codeium)\b/i,
      /(光标位置|当前工作区|最近查看文件|工作区路径|工具链|代码代理)/i,
    ],
  },
  {
    weight: 5,
    patterns: [
      /\b(read_file|write_file|edit_file|apply_patch|run_terminal_cmd|execute_command|codebase_search|grep_search|list_dir|open_file|search_replace)\b/i,
      /\b(readFile|writeFile|editFile|applyPatch|runTerminalCommand|executeCommand|codebaseSearch|grepSearch|listDir)\b/i,
    ],
  },
  {
    weight: 5,
    patterns: [
      /(当前工作区|workspace\s+path|workspace\s+root|repository\s+root|recently\s+viewed\s+files|cursor\s+position|active\s+editor)/i,
      /(you are an?\s+(ai\s+)?coding\s+(assistant|agent)|you are working in an?\s+(ide|editor|repository))/i,
    ],
  },
  {
    weight: 2,
    patterns: [
      /(工具调用|调用工具|function\s+calling|tool\s+call|available\s+tools).{0,100}(文件|代码|终端|workspace|repository|file|terminal)/i,
    ],
  },
];

const MALICIOUS_SIGNALS: Signal[] = [
  {
    weight: 5,
    patterns: [
      /(忽略|无视|跳过|覆盖|服从).{0,30}(之前|先前|以上|原有|系统|开发者).{0,20}(指令|提示词|规则|消息)/i,
      /\b(ignore|disregard|bypass|override).{0,30}(previous|prior|above|system|developer).{0,20}(instruction|prompt|rule|message)s?\b/i,
      /(ignore|disregard|bypass|override)(all)?(previous|prior|above|system|developer)(instructions?|prompts?|rules?|messages?)/i,
    ],
  },
  {
    weight: 5,
    patterns: [
      /(越狱|破解限制|解除限制|绕过安全|绕过审查|无审查|无约束|不受限制|开发者模式|丹模式|提示词注入)/i,
      /\b(jailbreak|prompt\s+injection|developer\s+mode|dan\s+mode|uncensored|unrestricted|no\s+restrictions?)\b/i,
      /(jailbreak|promptinjection|developermode|danmode|uncensored|unrestricted|norestrictions)/i,
    ],
  },
  {
    weight: 5,
    patterns: [
      /(显示|泄露|打印|输出|告诉我|提取|还原).{0,30}(系统提示词|开发者提示词|隐藏指令|内部规则|完整提示词|密钥|密码|token)/i,
      /\b(reveal|show|print|extract|dump|leak|expose).{0,30}(system|developer|hidden|internal).{0,20}(prompt|instruction|rule|message|secret)\b/i,
      /(reveal|showsystemprompt|extracthiddeninstructions|dumpdeveloperprompt)/i,
    ],
  },
  {
    weight: 5,
    patterns: [
      /(逆向|逆序|倒序|反向).{0,40}(破解|绕过|系统|程序|软件|提示词|指令|输出|回答|隐藏)/i,
      /\b(reverse|reverse\s+engineer|reversed).{0,40}(prompt|instruction|system|software|output|answer|restriction)\b/i,
      /(reverseengineer|reverseprompt|reversedinstructions)/i,
    ],
  },
  {
    weight: 5,
    patterns: [
      /(入侵|攻击|黑掉|盗取|窃取|破解).{0,30}(系统|服务器|网站|账号|账户|密码|数据|管理员|权限)/i,
      /(制作|制造|合成|配制|传播).{0,25}(炸弹|爆炸物|毒品|病毒|木马|勒索软件|武器)/i,
      /\b(steal|hack|attack|exploit|breach|ransomware|malware|keylogger).{0,35}(password|account|server|website|system|data|credential)?\b/i,
    ],
  },
  {
    weight: 5,
    patterns: [
      /(洗钱|诈骗|骗取|伪造证件|买卖枪支|儿童色情|强奸|绑架|违法违纪|犯罪教程)/i,
      /\b(money\s+laundering|fraud|forgery|human\s+trafficking|child\s+sexual|illegal\s+instructions?)\b/i,
    ],
  },
  {
    weight: 3,
    patterns: [
      /(base64|十六进制|rot13|编码|混淆).{0,40}(执行|运行|绕过|隐藏|指令|脚本)/i,
      /\b(encode|obfuscate|base64|hex|rot13).{0,40}(execute|run|bypass|hide|command|script)\b/i,
      /(把规则藏起来|不要让系统发现|规避检测|绕过检测|隐藏真实意图)/i,
    ],
  },
];

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function collectText(
  value: unknown,
  parts: string[],
  seen: Set<object>,
  total: { value: number },
  includeKeys: boolean,
): void {
  if (total.value >= MAX_SCAN_TEXT) return;
  if (typeof value === 'string') {
    const text = value.slice(0, MAX_SCAN_TEXT - total.value);
    parts.push(text);
    total.value += text.length;
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, parts, seen, total, includeKeys);
    return;
  }
  for (const [key, item] of Object.entries(value as JsonRecord)) {
    if (includeKeys) collectText(key, parts, seen, total, includeKeys);
    collectText(item, parts, seen, total, includeKeys);
  }
}

function normalizeText(value: unknown, includeKeys = false): TextCorpus {
  const parts: string[] = [];
  collectText(value, parts, new Set(), { value: 0 }, includeKeys);
  const readable = parts
    .join('\n')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\ufeff]/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();

  return {
    readable,
    // 处理插入空格、标点和部分低成本混淆，例如 i g n o r e 或 jailbreak。
    compact: readable.replace(/[\p{P}\p{S}\s]+/gu, ''),
  };
}

function signalMatches(signal: Signal, corpus: TextCorpus): boolean {
  return signal.patterns.some((pattern) => pattern.test(corpus.readable) || pattern.test(corpus.compact));
}

function scoreSignals(corpus: TextCorpus, signals: Signal[]): number {
  return signals.reduce((score, signal) => score + (signalMatches(signal, corpus) ? signal.weight : 0), 0);
}

function systemContext(payload: JsonRecord): unknown[] {
  const context: unknown[] = [];
  if (typeof payload.instructions === 'string') context.push(payload.instructions);
  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) {
      if (!isRecord(message)) continue;
      if (message.role === 'system' || message.role === 'developer') context.push(message.content);
    }
  }
  if (Array.isArray(payload.tools)) context.push(payload.tools);
  for (const key of ['metadata', 'client', 'client_info', 'extra_body']) {
    if (payload[key] !== undefined) context.push(payload[key]);
  }
  return context;
}

function userContext(payload: JsonRecord): unknown[] {
  if (!Array.isArray(payload.messages)) {
    return [payload.input, payload.prompt, payload.query, payload.content].filter((value) => value !== undefined);
  }
  return payload.messages
    .filter(
      (message) =>
        !isRecord(message) ||
        (message.role !== 'system' && message.role !== 'developer'),
    )
    .map((message) => (isRecord(message) ? message.content ?? message : message));
}

export interface RequestInspection {
  isIdeRequest: boolean;
  isMalicious: boolean;
}

/**
 * 只负责分类，不决定 HTTP 行为。
 * IDE 证据只从系统上下文和工具链读取；恶意证据只从用户可控消息读取，
 * 避免系统提示词中讨论安全策略时触发恶意拦截。
 */
export function inspectRequest(payload: JsonRecord): RequestInspection {
  const ideScore = scoreSignals(normalizeText(systemContext(payload), true), IDE_SIGNALS);
  const maliciousScore = scoreSignals(normalizeText(userContext(payload)), MALICIOUS_SIGNALS);
  return {
    isIdeRequest: ideScore >= IDE_THRESHOLD,
    isMalicious: maliciousScore >= MALICIOUS_THRESHOLD,
  };
}

/** 删除客户端提供的 system/developer 消息；服务端内置规则会在之后重新注入。 */
export function stripClientSystemPrompts(payload: JsonRecord): JsonRecord {
  if (!Array.isArray(payload.messages)) return { ...payload };
  return {
    ...payload,
    messages: payload.messages.filter(
      (message) => !isRecord(message) || (message.role !== 'system' && message.role !== 'developer'),
    ),
  };
}