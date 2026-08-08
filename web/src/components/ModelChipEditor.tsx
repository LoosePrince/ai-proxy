/**
 * 模型列表编辑器。
 *
 * 旧实现是一个逗号分隔的 input：分不清「空格是分隔符还是模型名的一部分」，
 * 也无法看出到底存了几个模型。这里用 AntD 的多选 tag 模式，
 * 输入即成 chip，重复项由组件层去重。
 *
 * 输出契约固定为 string[]，去空去重，与后端 toModels 的口径一致。
 */

import { Select } from 'antd';

export function ModelChipEditor({
  value,
  onChange,
  placeholder = '输入模型名后回车',
  disabled,
}: {
  value: string[];
  onChange: (models: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <Select
      mode="tags"
      style={{ width: '100%' }}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      tokenSeparators={[',', '\n', ' ']}
      // 纯输入组件，不提供候选项，open=false 可避免弹出空下拉
      open={false}
      onChange={(next) => {
        const models = [...new Set(next.map((item) => String(item).trim()).filter(Boolean))];
        onChange(models);
      }}
    />
  );
}