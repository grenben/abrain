const MAX_FUTURE_TIMESTAMP_SKEW_MS = 24 * 60 * 60 * 1000;
const STRICT_RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?(Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/;

export function canonicalTimestamp(value: string): { iso: string; epochMs: number } | null {
  const match = value.match(STRICT_RFC3339);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);

  // Validate the source calendar fields independently of its timezone offset.
  // Date.parse otherwise rolls impossible values such as February 30 forward.
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    calendar.getUTCHours() !== hour ||
    calendar.getUTCMinutes() !== minute ||
    calendar.getUTCSeconds() !== second
  ) {
    return null;
  }

  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  if (ms > Date.now() + MAX_FUTURE_TIMESTAMP_SKEW_MS) return null;
  // Conversation segmentation and checkpoint comparisons expect one stable
  // UTC representation. Millisecond precision is not meaningful here.
  return { iso: new Date(ms).toISOString().slice(0, 19) + 'Z', epochMs: ms };
}
