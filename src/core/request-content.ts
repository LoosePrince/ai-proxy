import { createHash } from 'node:crypto';

import type { JsonRecord } from './protocol';
import type { PublicRequestContentEventDTO } from '../types/api';

const SENSITIVE_KEY = /authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|cookie/i;
const PRIVATE_ROLE = new Set(['system', 'developer']);
const MAX_PUBLIC_STRING = 2_000;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

/** 缓存只保存摘要键，不把请求正文或凭据复制进缓存表。 */
export function createRequestCacheKey(protocol: 'chat' | 'responses', payload: JsonRecord): string {
  const canonical = JSON.stringify({ protocol, payload: stableValue(payload) });
  return createHash('sha256').update(canonical).digest('hex');
}

function redactText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已脱敏]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[已脱敏]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[邮箱已脱敏]')
    .replace(/\b1[3-9]\d{9}\b/g, '[手机号已脱敏]')
    .slice(0, MAX_PUBLIC_STRING);
}

function redactValue(value: unknown, privateContext = false): unknown {
  if (privateContext) return '[系统内容已隐藏]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (!value || typeof value !== 'object') return value;

  const record = value as JsonRecord;
  const role = typeof record.role === 'string' ? record.role.toLowerCase() : '';
  const hideContent = PRIVATE_ROLE.has(role);

  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => {
      if (SENSITIVE_KEY.test(key)) return [key, '[已脱敏]'];
      if (hideContent && ['content', 'text', 'input', 'instructions'].includes(key)) {
        return [key, '[系统内容已隐藏]'];
      }
      return [key, redactValue(item)];
    }),
  );
}

export function createPublicContentEvent(input: {
  id: string;
  occurredAt: string;
  protocol: 'chat' | 'responses';
  stream: boolean;
  model: string | null;
  request: unknown;
  response: unknown;
}): PublicRequestContentEventDTO {
  return {
    ...input,
    request: redactValue(input.request),
    response: redactValue(input.response),
  };
}

export function parseCapturedBody(body: string, contentType: string): unknown {
  if (contentType.includes('json')) {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return body;
    }
  }
  return body;
}