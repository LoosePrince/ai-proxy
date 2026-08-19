import { findProviderById, updateProviderScriptRun } from '../db/repo/providers';
import { getConfig, invalidateConfig } from './config-cache';
import { nextCronTime } from './cron';
import { executeProviderMain, sanitizeProviderScriptError } from '../upstream/script';

interface Task {
  timer: NodeJS.Timeout;
}

const tasks = new Map<number, Task>();
const runningProviders = new Set<number>();
const controllers = new Map<number, AbortController>();
let started = false;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

function clearTask(id: number): void {
  const task = tasks.get(id);
  if (!task) return;
  clearTimeout(task.timer);
  tasks.delete(id);
}

function schedule(providerId: number): void {
  clearTask(providerId);
  void findProviderById(providerId).then((provider) => {
    if (
      !provider ||
      !provider.enabled ||
      provider.requestMode !== 'script' ||
      !provider.scheduleEnabled ||
      !provider.scheduleCron ||
      !provider.mainScript.trim()
    ) return;

    let next: Date;
    try {
      next = nextCronTime(provider.scheduleCron);
    } catch (error) {
      void updateProviderScriptRun(provider.id, { ok: false, error: (error as Error).message });
      return;
    }

    const delay = Math.max(0, next.getTime() - Date.now());
    const timer = setTimeout(() => {
      tasks.delete(provider.id);
      if (!started) return;
      void runProviderMain(provider.id)
        .catch(() => undefined)
        .finally(() => {
          if (started) schedule(provider.id);
        });
    }, Math.min(delay, MAX_TIMER_DELAY_MS));
    timer.unref?.();
    tasks.set(provider.id, { timer });
  }).catch(() => undefined);
}

export async function runProviderMain(providerId: number): Promise<{ updated: string[] }> {
  if (runningProviders.has(providerId)) throw new Error('Provider 主入口正在执行中');
  runningProviders.add(providerId);

  try {
    const provider = await findProviderById(providerId);
    if (!provider) throw new Error('Provider 不存在');
    if (!provider.enabled) throw new Error('Provider 已禁用');
    if (provider.requestMode !== 'script') throw new Error('只有脚本模式 Provider 可以执行主入口');
    if (!provider.mainScript.trim()) throw new Error('主入口代码为空');

    const controller = new AbortController();
    controllers.set(providerId, controller);
    try {
      const result = await executeProviderMain(provider, 120_000, controller.signal);
      invalidateConfig();
      return result;
    } catch (error) {
      if (!controller.signal.aborted) await updateProviderScriptRun(provider.id, { ok: false, error: sanitizeProviderScriptError(provider, error) });
      throw error;
    } finally {
      controllers.delete(providerId);
    }
  } finally {
    runningProviders.delete(providerId);
  }
}

export async function refreshProviderScriptSchedules(): Promise<void> {
  const config = await getConfig();
  const ids = config.providers
    .filter((provider) => (
      provider.enabled &&
      provider.requestMode === 'script' &&
      provider.scheduleEnabled &&
      provider.scheduleCron &&
      provider.mainScript.trim()
    ))
    .map((provider) => provider.id);
  for (const id of tasks.keys()) if (!ids.includes(id)) clearTask(id);
  if (started) ids.forEach(schedule);
}

export async function startProviderScriptScheduler(): Promise<void> {
  started = true;
  await refreshProviderScriptSchedules();
}

export function stopProviderScriptScheduler(): void {
  started = false;
  for (const id of tasks.keys()) clearTask(id);
  for (const controller of controllers.values()) controller.abort();
}