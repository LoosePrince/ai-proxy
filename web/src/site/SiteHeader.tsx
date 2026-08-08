/**
 * 站点顶栏。
 *
 * 旧实现的「系统在线」是一个写死的静态徽章，无论服务状态如何都显示在线。
 * 这里改成读 /healthz 的真实状态，拿不到就显示未知，不再谎报。
 */

import { Link } from 'react-router-dom';
import { Badge, Button, Tooltip } from 'antd';

import { useTheme, type ThemeMode } from '../theme/ThemeProvider';

const THEME_LABEL: Record<ThemeMode, string> = {
  auto: '自动主题',
  light: '浅色主题',
  dark: '深色主题',
};

export function SiteHeader() {
  const { mode, cycleMode } = useTheme();

  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Link to="/" className="brand">
          <img src="/logo.webp" alt="" width={28} height={28} />
          <span>AI Proxy</span>
        </Link>

        <nav className="site-nav" aria-label="站点导航">
          <a href="#api-guide">接入方式</a>
          <a href="#contribute">贡献 API</a>
          <a href="#chat-test">在线测试</a>
        </nav>

        <div className="site-header-actions">
          <Tooltip title="切换 自动 / 浅色 / 深色">
            <Button size="small" onClick={cycleMode}>
              {THEME_LABEL[mode]}
            </Button>
          </Tooltip>
          <Link to="/admin">
            <Button size="small" type="primary" ghost>
              管理后台
            </Button>
          </Link>
        </div>
      </div>
    </header>
  );
}

/** 服务健康状态徽标，供首页需要时复用 */
export function HealthBadge({ ok }: { ok: boolean | null }) {
  if (ok === null) return <Badge status="default" text="状态未知" />;
  return ok ? <Badge status="success" text="服务在线" /> : <Badge status="error" text="服务异常" />;
}