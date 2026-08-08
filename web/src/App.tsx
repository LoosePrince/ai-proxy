/**
 * 路由骨架。
 *
 * 两个独立区域，各自有自己的外壳：
 *   /        站点首页（公开）
 *   /admin/* 管理后台（session 鉴权，AdminLayout 内做登录门禁）
 *
 * 后台代码用 lazy 分包：首页访客不必下载后台的表格与图表代码。
 */

import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Spin } from 'antd';

import { SitePage } from './site/SitePage';

const AdminLayout = lazy(() => import('./admin/AdminLayout'));

function PageFallback() {
  return (
    <div className="page-fallback">
      <Spin size="large" />
    </div>
  );
}

export function App() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/" element={<SitePage />} />
        <Route path="/admin/*" element={<AdminLayout />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}