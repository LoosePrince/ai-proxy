/**
 * 公开运行数据。
 *
 * 后端只读 global_usage 单行（旧实现是 Provider 全表扫描后在内存里聚合），
 * 因此这里可以放心做轮询刷新而不担心拖慢数据库。
 */

import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { Alert, Card, Skeleton } from 'antd';

import { publicApi } from '../api/client';
import { SectionHead } from '../components/SectionHead';
import { useAsync } from '../hooks/useAsync';
import { formatCount, formatPercent, formatTokens } from '../lib/format';

const REFRESH_MS = 30_000;

export function PublicStats() {
  const stats = useAsync(() => publicApi.stats(), []);

  useEffect(() => {
    const timer = setInterval(stats.reload, REFRESH_MS);
    return () => clearInterval(timer);
    // reload 是稳定引用，这里只需挂载时建立一次定时器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cards = [
    {
      label: '总请求数',
      value: stats.data ? formatCount(stats.data.totalRequests) : '--',
      hint: '累计 API 调用次数',
    },
    {
      label: '总 Token 数',
      value: stats.data ? formatTokens(stats.data.totalTokens) : '--',
      hint: 'Prompt 与 Completion 合计',
    },
    {
      label: '成功率',
      value: stats.data ? formatPercent(stats.data.successRate) : '--',
      hint: '已完成请求的成功占比',
    },
  ];

  return (
    <section className="section" id="stats" aria-label="公开运行数据">
      <SectionHead
        kicker="Live data"
        title="公开运行数据"
        desc="用三个核心指标快速判断服务当前使用规模和可用状态。"
      />

      {stats.status === 'error' ? (
        <Alert type="warning" showIcon message="统计数据暂时无法加载" description={stats.error} />
      ) : (
        <div className="stat-grid">
          {cards.map((card, index) => (
            <motion.div
              key={card.label}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.06 }}
            >
              <Card className="stat-card" bordered={false}>
                <div className="label">{card.label}</div>
                {stats.status === 'success' ? (
                  <div className="value">{card.value}</div>
                ) : (
                  <Skeleton.Input active size="large" style={{ width: 120 }} />
                )}
                <div className="hint">{card.hint}</div>
              </Card>
            </motion.div>
          ))}
        </div>
      )}
    </section>
  );
}