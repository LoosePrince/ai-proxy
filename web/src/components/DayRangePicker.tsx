/**
 * 日期范围选择。
 *
 * 三个统计页（Provider / 模型 / IP）与概览都需要同一套范围过滤。
 * 后端聚合表按 UTC 的 `YYYY-MM-DD` 分桶，因此这里统一输出该格式的字符串，
 * 而不是 Date 对象 —— 时区转换只在这一处发生，页面拿到的就是可直接下发的值。
 *
 * hook 与展示组件分开：页面需要 range 触发请求，也需要把控制权交给选择器，
 * 两者耦在一个组件里会让页面无法把 range 放进依赖数组。
 */

import { useCallback, useMemo, useState } from 'react';
import { DatePicker, Segmented, Space } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';

export interface DayRange {
  from?: string;
  to?: string;
}

type Preset = '7d' | '30d' | 'all' | 'custom';

const PRESET_DAYS: Record<'7d' | '30d', number> = { '7d': 7, '30d': 30 };

function toDay(value: Dayjs): string {
  return value.format('YYYY-MM-DD');
}

function presetRange(preset: '7d' | '30d'): DayRange {
  const days = PRESET_DAYS[preset];
  return { from: toDay(dayjs().subtract(days - 1, 'day')), to: toDay(dayjs()) };
}

export interface DayRangeControl {
  preset: Preset;
  custom: [Dayjs, Dayjs] | null;
  onPreset: (preset: Preset) => void;
  onCustom: (value: [Dayjs, Dayjs] | null) => void;
}

export function useDayRange(initial: Preset = 'all'): { range: DayRange; control: DayRangeControl } {
  const [preset, setPreset] = useState<Preset>(initial);
  const [custom, setCustom] = useState<[Dayjs, Dayjs] | null>(null);

  const range = useMemo<DayRange>(() => {
    if (preset === 'all') return {};
    if (preset === 'custom') {
      // 自定义但还没选完时按「全部」处理，避免下发半个区间
      if (!custom) return {};
      return { from: toDay(custom[0]), to: toDay(custom[1]) };
    }
    return presetRange(preset);
  }, [preset, custom]);

  const onPreset = useCallback((next: Preset) => {
    setPreset(next);
    if (next !== 'custom') setCustom(null);
  }, []);

  const onCustom = useCallback((value: [Dayjs, Dayjs] | null) => {
    setCustom(value);
    setPreset(value ? 'custom' : 'all');
  }, []);

  return { range, control: { preset, custom, onPreset, onCustom } };
}

export function DayRangePicker({ preset, custom, onPreset, onCustom }: DayRangeControl) {
  return (
    <Space wrap>
      <Segmented
        size="small"
        value={preset}
        onChange={(value) => onPreset(value as Preset)}
        options={[
          { label: '近 7 天', value: '7d' },
          { label: '近 30 天', value: '30d' },
          { label: '全部', value: 'all' },
        ]}
      />
      <DatePicker.RangePicker
        size="small"
        value={custom}
        onChange={(value) =>
          onCustom(value && value[0] && value[1] ? [value[0], value[1]] : null)
        }
      />
    </Space>
  );
}