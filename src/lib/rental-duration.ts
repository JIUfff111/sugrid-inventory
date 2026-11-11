export type RentalBillingUnit = 'day' | 'month';

type CalendarDate = { year: number; month: number; day: number };

function parseCalendarDate(value: string): CalendarDate | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate() };
}

function makeUTCDate(year: number, month: number, day: number) {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month, day);
  return date;
}

function formatUTCDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function isValidRentalDate(value: string) {
  return parseCalendarDate(value) !== null;
}

export function addRentalDays(start: string, days: number): string | null {
  const parsed = parseCalendarDate(start);
  if (!parsed || !Number.isSafeInteger(days)) return null;
  const date = makeUTCDate(parsed.year, parsed.month, parsed.day + days);
  return Number.isFinite(date.getTime()) ? formatUTCDate(date) : null;
}

export function addRentalMonths(start: string, months: number): string | null {
  const parsed = parseCalendarDate(start);
  if (!parsed || !Number.isSafeInteger(months)) return null;
  const targetMonthIndex = parsed.year * 12 + parsed.month + months;
  const targetYear = Math.floor(targetMonthIndex / 12);
  const targetMonth = targetMonthIndex - targetYear * 12;
  const lastDay = makeUTCDate(targetYear, targetMonth + 1, 0).getUTCDate();
  const date = makeUTCDate(targetYear, targetMonth, Math.min(parsed.day, lastDay));
  return Number.isFinite(date.getTime()) ? formatUTCDate(date) : null;
}

export function calculateRentalDuration(start: string, end: string, unit: RentalBillingUnit): number {
  const startDate = parseCalendarDate(start);
  const endDate = parseCalendarDate(end);
  if (!startDate || !endDate) return 0;

  const startValue = makeUTCDate(startDate.year, startDate.month, startDate.day).getTime();
  const endValue = makeUTCDate(endDate.year, endDate.month, endDate.day).getTime();
  if (endValue <= startValue) return 0;

  if (unit === 'day') return Math.floor((endValue - startValue) / 86400000);

  let months = (endDate.year - startDate.year) * 12 + endDate.month - startDate.month;
  if (months <= 0) return 0;
  const anniversary = addRentalMonths(start, months);
  if (!anniversary || anniversary > end) months -= 1;
  return Math.max(0, months);
}
