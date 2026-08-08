/**
 * 首屏。
 *
 * 旧实现顶栏挂了一个写死的「系统在线」徽章。这里改为真实读 /healthz：
 * 拿到 ok 才显示在线，请求失败显示异常，未返回前显示未知。
 */

import { motion } from 'framer-motion';
import { Button, Space } from 'antd';

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

export function Hero() {
  const health = useAsync(checkHealth, []);
  // 请求还没落地时是「未知」，失败时明确是「异常」，不猜测
  const ok = health.status === 'success' ? health.data : health.status === 'error' ? false : null;

  return (
    <section className="hero" aria-label="首页介绍">
      <motion.div
        className="hero-inner"
        initial="hidden"
        animate="show"
        variants={{ show: { transition: { staggerChildren: 0.08 } } }}
      >
        <motion.div className="eyebrow" variants={fadeUp}>
          <span>免费 AI API · OpenAI 兼容 · 无需注册</span>
          <HealthBadge ok={ok} />
        </motion.div>

        <motion.h1 variants={fadeUp}>
          免费 AI API
          <br />
          <span>打开就能用。</span>
        </motion.h1>

        <motion.p className="hero-description" variants={fadeUp}>
          面向开发者和轻量应用的免费 AI 接口服务。无需注册账号，无需单独申请 Key，
          使用标准 API 地址即可快速完成聊天、测试和原型验证。
        </motion.p>

        <motion.div variants={fadeUp}>
          <Space wrap>
            <Button type="primary" size="large" href="#chat-test">
              立即测试
            </Button>
            <Button size="large" href="#api-guide">
              查看接入方式
            </Button>
            <Button size="large" href="#contribute">
              贡献 API
            </Button>
          </Space>
        </motion.div>
      </motion.div>
    </section>
  );
}