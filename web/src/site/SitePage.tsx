/**
 * 站点首页外壳。
 *
 * 旧实现是一个 1297 行的 index.html：前 958 行内嵌 CSS，尾部一个 IIFE 里塞了
 * 主题切换、统计加载、贡献列表渲染（三层 innerHTML 字符串拼接）与表单提交。
 * 这里按内容块拆成独立组件，每块自己管自己的数据获取与状态。
 *
 * 各块之间无共享状态，因此不需要任何全局 store：
 *   Hero        纯展示 + 锚点跳转
 *   PublicStats 读 /api/public-stats
 *   ApiGuide    从 window.location.origin 推导 API Base
 *   Contribute  读写 /api/contributions
 *   ChatDemo    调 /v1/chat/completions
 */

import { SiteHeader } from './SiteHeader';
import { Hero } from './Hero';
import { PublicStats } from './PublicStats';
import { ApiGuide } from './ApiGuide';
import { Contribute } from './Contribute';
import { ChatDemo } from './ChatDemo';
import { SiteFooter } from './SiteFooter';
import './site.css';

export function SitePage() {
  return (
    <div className="site">
      <SiteHeader />
      <main>
        <Hero />
        <PublicStats />
        <ApiGuide />
        <Contribute />
        <ChatDemo />
      </main>
      <SiteFooter />
    </div>
  );
}