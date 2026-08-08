/**
 * 主题体系。
 *
 * 三态：auto / light / dark。auto 跟随系统偏好，且系统偏好变化时实时响应
 * （旧实现只在页面加载时读一次 prefers-color-scheme，切换系统主题后不更新）。
 *
 * 单一数据源是 `mode`（用户选择），`resolved` 是派生态（实际生效的明暗）。
 * 两处消费者：
 *   - CSS 变量：通过 document.documentElement 的 data-theme 属性切换
 *   - Ant Design：通过 ConfigProvider 的 algorithm 切换
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ConfigProvider, theme as antdTheme } from 'antd';

export type ThemeMode = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'ai-proxy-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  /** 在 auto -> light -> dark 之间循环，供顶栏单按钮使用 */
  cycleMode: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'auto' ? stored : 'auto';
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme);

  // auto 模式下跟随系统实时变化
  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => setSystem(event.matches ? 'dark' : 'light');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const resolved: ResolvedTheme = mode === 'auto' ? system : mode;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

  const setMode = useCallback((next: ThemeMode) => {
    localStorage.setItem(STORAGE_KEY, next);
    setModeState(next);
  }, []);

  const cycleMode = useCallback(() => {
    const order: ThemeMode[] = ['auto', 'light', 'dark'];
    setMode(order[(order.indexOf(mode) + 1) % order.length] ?? 'auto');
  }, [mode, setMode]);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolved, setMode, cycleMode }),
    [mode, resolved, setMode, cycleMode],
  );

  return (
    <ThemeContext.Provider value={value}>
      <ConfigProvider
        theme={{
          algorithm: resolved === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: {
            colorPrimary: resolved === 'dark' ? '#8293ff' : '#5267e8',
            colorInfo: resolved === 'dark' ? '#8293ff' : '#5267e8',
            colorSuccess: resolved === 'dark' ? '#41c996' : '#15966c',
            colorWarning: resolved === 'dark' ? '#e9a844' : '#c98216',
            colorError: resolved === 'dark' ? '#f17286' : '#d9485f',
            borderRadius: 10,
            borderRadiusLG: 16,
            controlHeight: 38,
            fontSize: 14,
            fontFamily:
              "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
          },
          components: {
            Button: {
              controlHeightLG: 46,
              paddingInlineLG: 22,
              fontWeight: 550,
            },
            Card: {
              headerFontSize: 15,
              bodyPadding: 20,
            },
            Menu: {
              itemBorderRadius: 9,
              itemMarginInline: 10,
            },
            Table: {
              headerBorderRadius: 8,
              cellPaddingBlockSM: 11,
              cellPaddingInlineSM: 12,
            },
          },
        }}
      >
        {children}
      </ConfigProvider>
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within ThemeProvider');
  return context;
}