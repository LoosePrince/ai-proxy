/**
 * 后台外壳：登录门禁 + 侧边导航 + 子路由出口。
 *
 * 旧 public/admin.html 是 850 行全局 JS：登录态靠一个全局变量、页面切换靠
 * 手动 display 显隐、按钮回调写在 onclick 字符串里传参。这里改为：
 *   - 登录态由 /admin/api/auth-check 单一来源决定，未登录时整个后台不渲染
 *   - 页面切换走 react-router 真实 URL，可收藏、可刷新、可后退
 *   - 每个页面自己管自己的数据，互不共享状态
 *
 * 注意：needAuth=false（未配置 ADMIN_USERNAME/PASSWORD）时后端本身就不设门禁，
 * 前端也就不显示登录框 —— 前端加锁只是装饰，真正的边界在服务端。
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Button, Drawer, Layout, Menu, Result, Spin, Tooltip } from 'antd';
import {
  ApiOutlined,
  BarChartOutlined,
  DashboardOutlined,
  GlobalOutlined,
  MenuOutlined,
  ProfileOutlined,
  SettingOutlined,
} from '@ant-design/icons';

import { adminApi } from '../api/client';
import { useAsync } from '../hooks/useAsync';
import { useTheme, type ThemeMode } from '../theme/ThemeProvider';
import { LoginGate } from './LoginGate';
import { Dashboard } from './Dashboard';
import { Providers } from './Providers';
import { SettingsPage } from './SettingsPage';
import { ModelStats } from './ModelStats';
import { IpStats } from './IpStats';
import { RequestLogs } from './RequestLogs';
import './admin.css';

const { Sider, Content, Header } = Layout;

const THEME_LABEL: Record<ThemeMode, string> = {
  auto: '自动主题',
  light: '浅色主题',
  dark: '深色主题',
};

const NAV = [
  { key: '', icon: <DashboardOutlined />, label: '概览', desc: '全站用量与运行状态' },
  { key: 'providers', icon: <ApiOutlined />, label: 'Provider', desc: '上游节点与路由分组' },
  { key: 'logs', icon: <ProfileOutlined />, label: '请求日志', desc: '调用链路与错误详情' },
  { key: 'models', icon: <BarChartOutlined />, label: '模型统计', desc: '模型调用与 Token 分布' },
  { key: 'ips', icon: <GlobalOutlined />, label: 'IP 统计', desc: '访问来源与用量分析' },
  { key: 'settings', icon: <SettingOutlined />, label: '设置', desc: '路由策略与运行参数' },
];

export default function AdminLayout() {
  const location = useLocation();
  const { mode, cycleMode } = useTheme();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const auth = useAsync(() => adminApi.authCheck(), []);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  const logout = useCallback(async () => {
    await adminApi.logout();
    auth.reload();
  }, [auth]);

  if (auth.status === 'loading' || auth.status === 'idle') {
    return (
      <div className="page-fallback">
        <Spin size="large" />
      </div>
    );
  }

  if (auth.status === 'error') {
    return (
      <Result
        status="warning"
        title="无法确认登录状态"
        subTitle={auth.error ?? '请确认服务是否可用'}
        extra={
          <Button type="primary" onClick={auth.reload}>
            重试
          </Button>
        }
      />
    );
  }

  // needAuth 为真且未认证时，只渲染登录框，后台内容完全不加载
  if (auth.data?.needAuth && !auth.data.authenticated) {
    return <LoginGate onSuccess={auth.reload} />;
  }

  // 侧边栏选中项由 URL 派生，不额外维护 activeTab 状态
  const segment = location.pathname.replace(/^\/admin\/?/, '').split('/')[0] ?? '';
  const activeNav = NAV.find((item) => item.key === segment) ?? NAV[0]!;
  const navItems = NAV.map((item) => ({
    key: item.key,
    icon: item.icon,
    label: <Link to={`/admin/${item.key}`}>{item.label}</Link>,
  }));

  return (
    <Layout className="admin-shell">
      <Header className="admin-header">
        <div className="admin-header-leading">
          <Button
            className="admin-mobile-nav-button"
            type="text"
            icon={<MenuOutlined />}
            aria-label="打开后台导航"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen(true)}
          />
          <Link to="/" className="brand admin-brand">
            <span className="admin-brand-mark">
              <img src="/logo.webp" alt="" width={26} height={26} />
            </span>
            <span className="admin-brand-copy">
              <strong>AI Proxy</strong>
              <small>控制台</small>
            </span>
          </Link>
        </div>

        <div className="row">
          <Tooltip title="切换 自动 / 浅色 / 深色">
            <Button size="small" onClick={cycleMode}>
              {THEME_LABEL[mode]}
            </Button>
          </Tooltip>
          {auth.data?.needAuth ? (
            <Button size="small" onClick={() => void logout()}>
              退出登录
            </Button>
          ) : (
            <Tooltip title="未设置 ADMIN_USERNAME / ADMIN_PASSWORD，后台当前对外开放">
              <Button size="small" danger>
                未启用鉴权
              </Button>
            </Tooltip>
          )}
        </div>
      </Header>

      <Drawer
        rootClassName="admin-mobile-drawer"
        title="后台导航"
        placement="left"
        width={280}
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
      >
        <Menu
          mode="inline"
          selectedKeys={[segment]}
          items={navItems}
          onClick={() => setMobileNavOpen(false)}
        />
      </Drawer>

      <Layout>
        <Sider className="admin-sider" width={208}>
          <div className="sider-caption">Workspace</div>
          <Menu mode="inline" selectedKeys={[segment]} items={navItems} />
        </Sider>

        <Content className="admin-content">
          <div className="admin-content-inner">
            <div className="admin-page-heading">
              <span>Admin Console</span>
              <h1>{activeNav.label}</h1>
              <p>{activeNav.desc}</p>
            </div>
            <Routes>
              <Route index element={<Dashboard />} />
              <Route path="providers" element={<Providers />} />
              <Route path="logs" element={<RequestLogs />} />
              <Route path="models" element={<ModelStats />} />
              <Route path="ips" element={<IpStats />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/admin" replace />} />
            </Routes>
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}