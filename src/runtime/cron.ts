interface CronField {
  values: Set<number>;
  wildcard: boolean;
}

export interface CronSchedule {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

function parseField(source: string, min: number, max: number): CronField {
  const normalized = source.trim();
  if (!normalized) throw new Error('cron 字段不能为空');
  const values = new Set<number>();
  const parts = normalized.split(',');
  for (const part of parts) {
    const pieces = part.split('/');
    if (pieces.length > 2) throw new Error(`无效 cron 字段: ${part}`);
    const rangeSource = pieces[0] ?? '';
    const step = pieces[1] === undefined ? 1 : Number(pieces[1]);
    if (!Number.isInteger(step) || step <= 0) throw new Error(`无效 cron 步长: ${part}`);

    const bounds = rangeSource === '*' ? [min, max] : rangeSource.split('-').map(Number);
    const start = bounds[0] ?? NaN;
    const end = bounds.length === 1 ? start : (bounds[1] ?? NaN);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error(`无效 cron 字段: ${part}`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return { values, wildcard: parts.length === 1 && normalized === '*' };
}

export function parseCron(expression: string): CronSchedule {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron 必须包含 5 个字段（UTC：分 时 日 月 周）');
  return {
    minute: parseField(parts[0] ?? '', 0, 59),
    hour: parseField(parts[1] ?? '', 0, 23),
    dayOfMonth: parseField(parts[2] ?? '', 1, 31),
    month: parseField(parts[3] ?? '', 1, 12),
    dayOfWeek: parseField(parts[4] ?? '', 0, 6),
  };
}

export function nextCronTime(expression: string, after = new Date()): Date {
  const schedule = parseCron(expression);
  const candidate = new Date(after.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  for (let i = 0; i < 366 * 24 * 60; i += 1) {
    const monthMatches = schedule.month.values.has(candidate.getUTCMonth() + 1);
    const dayOfMonthMatches = schedule.dayOfMonth.values.has(candidate.getUTCDate());
    const dayOfWeekMatches = schedule.dayOfWeek.values.has(candidate.getUTCDay());
    const dayMatches = schedule.dayOfMonth.wildcard && schedule.dayOfWeek.wildcard
      ? true
      : schedule.dayOfMonth.wildcard
        ? dayOfWeekMatches
        : schedule.dayOfWeek.wildcard
          ? dayOfMonthMatches
          : dayOfMonthMatches || dayOfWeekMatches;
    if (
      schedule.minute.values.has(candidate.getUTCMinutes()) &&
      schedule.hour.values.has(candidate.getUTCHours()) &&
      monthMatches &&
      dayMatches
    ) return candidate;
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  throw new Error('cron 在未来 366 天内没有可执行时间');
}

export function validateCron(expression: string): string {
  const normalized = expression.trim();
  if (!normalized) return '';
  parseCron(normalized);
  return normalized;
}