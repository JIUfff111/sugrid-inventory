const timestampPattern = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

const displayFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** SQLite UTC timestamps omit the zone; ISO timestamps can carry an explicit offset. */
export function parseStoredTimestamp(value: string | null | undefined): Date | null {
  const match = value?.trim().match(timestampPattern);
  if (!match) return null;
  const [, day, minutes, seconds = '00', fraction = '', zone = 'Z'] = match;
  const utcWallTime = new Date(`${day}T${minutes}:${seconds}${fraction}Z`);
  if (!Number.isFinite(utcWallTime.getTime()) || utcWallTime.toISOString().slice(0, 19) !== `${day}T${minutes}:${seconds}`) return null;
  if (zone.toUpperCase() === 'Z') return utcWallTime;
  const timestamp = new Date(`${day}T${minutes}:${seconds}${fraction}${zone}`);
  return Number.isFinite(timestamp.getTime()) ? timestamp : null;
}

/** Display event times in China Standard Time. Calendar dates and legacy text stay as entered. */
export function formatDisplayDateTime(value: string | null | undefined, fallback = '—', { preserveUnzoned = false } = {}): string {
  if (preserveUnzoned && value?.trim().match(timestampPattern)?.[5] === undefined) return value?.trim() || fallback;
  const timestamp = parseStoredTimestamp(value);
  if (!timestamp) return value?.trim() || fallback;
  const parts = Object.fromEntries(displayFormatter.formatToParts(timestamp).map(({ type, value: part }) => [type, part]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Backfilled movements copied legacy values that did not consistently record a time zone. */
export function formatMovementDateTime(id: string, value: string | null | undefined): string {
  return formatDisplayDateTime(value, '—', { preserveUnzoned: /^(opening|historical)_/.test(id) });
}
