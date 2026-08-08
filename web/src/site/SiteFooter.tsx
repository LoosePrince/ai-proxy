/**
 * 站点页脚。API Base 与顶部指南同源推导，不写死域名。
 */

import { apiBase } from './origin';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div>© {new Date().getFullYear()} 免费 AI API · 即开即用</div>
      <div>
        API Base: <code>{apiBase()}</code>
      </div>
    </footer>
  );
}