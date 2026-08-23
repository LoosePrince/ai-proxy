/**
 * 首屏。
 *
 * 旧实现顶栏挂了一个写死的「系统在线」徽章。这里改为真实读 /healthz：
 * 拿到 ok 才显示在线，请求失败显示异常，未返回前显示未知。
 */

import { useState, type PointerEvent } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Button } from 'antd';
import { ArrowRightOutlined, CheckCircleFilled, CodeOutlined } from '@ant-design/icons';

import { useAsync } from '../hooks/useAsync';
import { HealthBadge } from './SiteHeader';

const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0 },
};

async function checkHealth(): Promise<boolean> {
  const response = await fetch('/healthz');
  const body = (await response.json()) as { ok?: boolean };
  return !!body.ok;
}

type CardTilt = {
  rotateX: number;
  rotateY: number;
};

const RESTING_TILT: CardTilt = { rotateX: 1, rotateY: -3 };

export function Hero() {
  const health = useAsync(checkHealth, []);
  const prefersReducedMotion = useReducedMotion();
  const [cardTilt, setCardTilt] = useState<CardTilt>(RESTING_TILT);
  // 请求还没落地时是「未知」，失败时明确是「异常」，不猜测
  const ok = health.status === 'success' ? health.data : health.status === 'error' ? false : null;

  const handleCardPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (prefersReducedMotion || event.pointerType !== 'mouse') return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;

    // 角度保持很小，卡片向光标方向略微后仰，不影响阅读与点击。
    setCardTilt({
      rotateX: 1 + (0.5 - y) * 4,
      rotateY: -3 + (x - 0.5) * 6,
    });
  };

  const resetCardTilt = () => setCardTilt(RESTING_TILT);

  return (
    <section className="hero" aria-label="首页介绍">
      <motion.div
        className="hero-inner"
        initial="hidden"
        animate="show"
        variants={{ show: { transition: { staggerChildren: 0.08 } } }}
      >
        <div className="hero-copy">
          <motion.div className="eyebrow" variants={fadeUp}>
            <span className="eyebrow-dot" aria-hidden="true" />
            <span>Chat Completions / Responses，免费开放</span>
            <HealthBadge ok={ok} />
          </motion.div>

          <motion.h1 variants={fadeUp}>
            一个地址，
            <br />
            <span>接入你的 AI 应用。</span>
          </motion.h1>

          <motion.div className="hero-actions" variants={fadeUp}>
            <Button type="primary" size="large" href="#chat-test" icon={<ArrowRightOutlined />} iconPosition="end">
              立即在线测试
            </Button>
            <Button size="large" href="#api-guide" icon={<CodeOutlined />}>
              查看接入代码
            </Button>
          </motion.div>

        </div>

        <motion.div className="hero-preview" variants={fadeUp} aria-label="API 请求示例">
          <div className="preview-glow" aria-hidden="true" />
          <motion.div
            className="endpoint-window"
            style={{
              rotateX: prefersReducedMotion ? 0 : cardTilt.rotateX,
              rotateY: prefersReducedMotion ? 0 : cardTilt.rotateY,
            }}
            transition={{ type: 'spring', stiffness: 320, damping: 28, mass: 0.35 }}
            onPointerMove={handleCardPointerMove}
            onPointerLeave={resetCardTilt}
          >
            <div className="window-bar">
              <div className="window-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
              <span>POST /v1/responses · /responses</span>
              <span className="window-secure">HTTPS</span>
            </div>
            <pre className="hero-code"><code><span className="code-punctuation">{'{'}</span>{'\n'}  <span className="code-key">"model"</span>: <span className="code-string">"deepseek-reasoner"</span>,{'\n'}  <span className="code-key">"input"</span>: <span className="code-string">"你好，请先思考再回答"</span>,{'\n'}  <span className="code-key">"reasoning"</span>: <span className="code-punctuation">{'{'}</span>{'\n'}    <span className="code-key">"effort"</span>: <span className="code-string">"high"</span>{'\n'}  <span className="code-punctuation">{'}'}</span>,{'\n'}  <span className="code-key">"stream"</span>: <span className="code-boolean">true</span>{'\n'}<span className="code-punctuation">{'}'}</span></code></pre>
            <div className="response-strip">
              <span className="response-status"><i /> 200 OK</span>
              <span>text/event-stream</span>
              <span className="response-time">流式返回</span>
            </div>
          </motion.div>
          <div className="floating-card floating-card-model">
            <span>模型名相近匹配</span>
            <strong>自动映射真实模型</strong>
          </div>
          <div className="floating-card floating-card-ready">
            <CheckCircleFilled />
            <div>
              <span>API Ready</span>
              <strong>即开即用</strong>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </section>
  );
}