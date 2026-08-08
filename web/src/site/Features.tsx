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
    title: '兼容双协议',
    desc: '同时支持 Chat Completions 与 Responses，全部端点均可选择是否保留 /v1 前缀。',
    icon: <ApiOutlined />,
  },
  {
    title: '模型与思考适配',
    desc: '相近模型名自动映射到真实配置，并兼容多轮 reasoning_content 与流式思考输出。',
    icon: <ThunderboltOutlined />,
  },
];

export function Features() {
  return (
    <section className="section" aria-label="功能说明">
      <SectionHead
        kicker="Why use it"
        title="为快速使用而设计"
        desc="一套地址兼容多种 OpenAI 客户端与请求格式，适合快速体验、原型开发和轻量应用接入。"
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