import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { Alert, Button } from 'antd';
import { ArrowLeftOutlined, LinkOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';

import { publicApi } from '../api/client';
import { useAsync } from '../hooks/useAsync';
import { SiteHeader } from './SiteHeader';
import { SiteFooter } from './SiteFooter';
import guideMarkdown from './guide.md?raw';
import './site.css';
import './guide.css';

export function GuidePage() {
  const config = useAsync(() => publicApi.siteConfig(), []);
  const projectUrl = config.data?.projectUrl ?? 'https://github.com/LoosePrince/ai-proxy';
  const markdown = useMemo(
    () => guideMarkdown.replaceAll('{{PROJECT_URL}}', projectUrl),
    [projectUrl],
  );

  return (
    <div className="site guide-page">
      <SiteHeader />
      <main className="guide-main">
        <div className="guide-toolbar">
          <Button type="text" icon={<ArrowLeftOutlined />}>
            <Link to="/">返回首页</Link>
          </Button>
          <a href={projectUrl} target="_blank" rel="noreferrer">
            <Button type="text" icon={<LinkOutlined />}>项目地址</Button>
          </a>
        </div>
        {config.status === 'error' ? (
          <Alert type="warning" showIcon message="项目配置暂时不可用，已使用默认项目地址。" />
        ) : null}
        <article className="guide-document">
          <ReactMarkdown>{markdown}</ReactMarkdown>
        </article>
      </main>
      <SiteFooter />
    </div>
  );
}