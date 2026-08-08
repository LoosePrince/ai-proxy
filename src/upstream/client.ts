/**
 * 上游 OpenAI 客户端缓存。
 *
 * 旧实现用一个无上界的 `Map<baseUrl::apiKey, OpenAI>`：apiKey 轮换后旧实例
 * 永久驻留，provider 数量多或 key 频繁变更时会持续泄漏。这里改为 LRU，
 * 容量固定，最久未使用的实例自然淘汰。
 */

import OpenAI from 'openai';

const MAX_CLIENTS = 64;

/** Map 保持插入顺序，命中后重新插入即可实现 LRU */
const clients = new Map<string, OpenAI>();

export interface UpstreamTarget {
  baseUrl: string;
  apiKey: string;
}

export function getUpstreamClient(target: UpstreamTarget): OpenAI {
  const key = `${target.baseUrl}::${target.apiKey}`;
  const cached = clients.get(key);

  if (cached) {
    clients.delete(key);
    clients.set(key, cached);
    return cached;
  }

  const client = new OpenAI({
    baseURL: target.baseUrl,
    apiKey: target.apiKey,
    // 重试与超时由 core/timeout 统一控制，避免两层重试叠加放大延迟
    maxRetries: 0,
  });

  clients.set(key, client);

  if (clients.size > MAX_CLIENTS) {
    const oldest = clients.keys().next().value;
    if (oldest !== undefined) clients.delete(oldest);
  }

  return client;
}

export function clearUpstreamClients(): void {
  clients.clear();
}

export function upstreamClientCount(): number {
  return clients.size;
}