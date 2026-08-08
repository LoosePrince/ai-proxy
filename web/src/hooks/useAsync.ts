/**
 * 异步数据获取的统一状态机。
 *
 * 旧实现里每个数据块都手写一遍 `try { fetch } catch { 兜底文案 }`，
 * 且加载中态与错误态各不相同。这里把状态收拢为一个显式四态机，
 * 页面只负责渲染，不再各自发明状态字段。
 *
 *   idle -> loading -> success
 *                   \-> error -> loading（reload 重试）
 *
 * 卸载后不再 setState：首页几个块都会在切页时卸载，
 * 否则慢请求返回时会触发 React 的卸载后更新警告。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type AsyncStatus = 'idle' | 'loading' | 'success' | 'error';

export interface AsyncState<T> {
  status: AsyncStatus;
  data: T | null;
  error: string | null;
  /** 重新拉取，忽略当前状态 */
  reload: () => void;
}

export function useAsync<T>(fetcher: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [status, setStatus] = useState<AsyncStatus>('idle');
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // fetcher 通常是内联箭头函数，用 ref 持有以免把它列入依赖导致每帧重跑
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    setStatus('loading');
    setError(null);

    try {
      const result = await fetcherRef.current();
      if (!alive.current) return;
      setData(result);
      setStatus('success');
    } catch (caught) {
      if (!alive.current) return;
      setError((caught as Error)?.message || '请求失败');
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { status, data, error, reload: () => void run() };
}