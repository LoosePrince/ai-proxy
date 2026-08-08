/**
 * 区块标题。
 *
 * 旧实现每个 section 都重复一遍 kicker / title / desc 三层 DOM 结构，
 * 改一处样式要改六处。这里收成一个组件，结构与间距只有一份定义。
 */

import type { ReactNode } from 'react';

export function SectionHead({
  kicker,
  title,
  desc,
}: {
  kicker: string;
  title: string;
  desc?: ReactNode;
}) {
  return (
    <div className="section-head">
      <div>
        <div className="section-kicker">{kicker}</div>
        <h2 className="section-title">{title}</h2>
      </div>
      {desc ? <p className="section-desc">{desc}</p> : null}
    </div>
  );
}