/**
 * 特性说明块。纯静态内容，数据即列表，渲染是列表的映射。
 */

import { motion } from 'framer-motion';
import { ApiOutlined, SafetyCertificateOutlined, ThunderboltOutlined } from '@ant-design/icons';

import { SectionHead } from '../components/SectionHead';

const FEATURES = [
  {
    title: '无需注册',
    desc: '打开页面即可获得 API Base，调用时 API Key 可留空或填写任意字符。',
    icon: <SafetyCertificateOutlined />,
  },
  {
    title: '兼容 OpenAI 格式',
    desc: '沿用常见的 /v1/chat/completions 请求结构，迁移成本低。',
    icon: <ApiOutlined />,
  },
  {
    title: '先测再接入',
    desc: '页面内置在线对话框，可以直接验证服务是否可用，再复制请求示例接入项目。',
    icon: <ThunderboltOutlined />,
  },
];

export function Features() {
  return (
    <section className="section" aria-label="功能说明">
      <SectionHead
        kicker="Why use it"
        title="为快速使用而设计"
        desc="免费开放的 AI 接口服务，适合快速体验、原型开发和轻量应用接入。"
      />

      <div className="feature-grid">
        {FEATURES.map((feature, index) => (
          <motion.div
            key={feature.title}
            className="feature-item"
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-40px' }}
            transition={{ delay: index * 0.06 }}
          >
            <div className="feature-topline">
              <div className="feature-icon">{feature.icon}</div>
              <div className="feature-number">{String(index + 1).padStart(2, '0')}</div>
            </div>
            <strong>{feature.title}</strong>
            <span>{feature.desc}</span>
          </motion.div>
        ))}
      </div>
    </section>
  );
}