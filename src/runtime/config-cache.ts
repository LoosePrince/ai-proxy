/**
 * 配置内存快照。
 *
 * 这是整个 Lsqlite 迁移能否成立的关键。Lsqlite 每条 SQL 都是一次 HTTPS 往返，
 * 而旧实现每次代理请求要读 2 次 route controller（无缓存）。若照搬，
 * 每个 AI 请求都会先叠加数百毫秒的配置读取延迟。
 *
 * 这里把 providers / priority_groups / settings 全量装进一个不可变快照：
 *   - 热路径只读快照，零 DB 往返
 *   - 写操作显式调用 invalidate()，下次读取时重建
 *   - 并发重建共享同一个 Promise，避免惊群
 */

import { loadRoutingSnapshot, type PriorityGroupRecord, type ProviderRecord } from '../db/repo/providers';
import { loadSettings } from '../db/repo/settings';
import type { SettingsDTO } from '../types/api';

export interface ConfigSnapshot {
  providers: ProviderRecord[];
  groups: Map<number, PriorityGroupRecord>;
  settings: SettingsDTO;
  loadedAtMs: number;
}

let snapshot: ConfigSnapshot | null = null;
let loading: Promise<ConfigSnapshot> | null = null;

async function build(): Promise<ConfigSnapshot> {
  // 两次查询并发，重建成本约等于一次往返
  const [routing, settings] = await Promise.all([loadRoutingSnapshot(), loadSettings()]);

  return {
    providers: routing.providers,
    groups: routing.groups,
    settings,
    loadedAtMs: Date.now(),
  };
}

export async function getConfig(): Promise<ConfigSnapshot> {
  if (snapshot) return snapshot;

  // 并发调用共享同一次重建，避免冷启动瞬间打出多次相同查询
  if (!loading) {
    loading = build()
      .then((next) => {
        snapshot = next;
        loading = null;
        return next;
      })
      .catch((error) => {
        loading = null;
        throw error;
      });
  }

  return loading;
}

/** 任何写操作后必须调用，否则后续请求仍读旧快照 */
export function invalidateConfig(): void {
  snapshot = null;
  loading = null;
}

/** 供 /admin 与健康检查观察缓存状态 */
export function peekConfig(): ConfigSnapshot | null {
  return snapshot;
}

/** 启动时预热，把首个真实请求的重建成本前置到启动阶段 */
export async function warmConfig(): Promise<void> {
  await getConfig();
}