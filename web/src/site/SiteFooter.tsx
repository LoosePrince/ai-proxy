/**
 * 站点页脚。API Base 与顶部指南同源推导，不写死域名。
 */

import { apiBase } from './origin';
import { publicApi } from '../api/client';
import { useAsync } from '../hooks/useAsync';

export function SiteFooter() {
  const config = useAsync(() => publicApi.siteConfig(), []);
  const projectUrl = config.data?.projectUrl ?? 'https://github.com/LoosePrince/ai-proxy';

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
        <div className="footer-meta">
          <a href={projectUrl} target="_blank" rel="noreferrer">项目地址</a>
          <span>© {new Date().getFullYear()} AI Proxy</span>
        </div>
      </div>
    </footer>
  );
}