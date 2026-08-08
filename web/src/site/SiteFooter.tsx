/**
 * 站点页脚。API Base 与顶部指南同源推导，不写死域名。
 */

import { apiBase } from './origin';

export function SiteFooter() {
  return (
    <footer className="site-footer-wrap">
      <div className="site-footer">
        <div className="footer-brand">
          <span className="brand-mark brand-mark-small">
            <img src="/logo.webp" alt="" width={26} height={26} />
          </span>
          <div>
            <strong>AI Proxy</strong>
            <span>兼容 Chat Completions 与 Responses 的开放 AI API</span>
          </div>
        </div>
        <div className="footer-endpoint">
          <span>API Base</span>
          <code>{apiBase()}</code>
        </div>
        <div className="footer-meta">© {new Date().getFullYear()} AI Proxy</div>
      </div>
    </footer>
  );
}