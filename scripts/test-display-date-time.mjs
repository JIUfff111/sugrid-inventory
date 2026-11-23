import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDisplayDateTime, formatMovementDateTime, parseStoredTimestamp } from '../src/lib/display-date-time.ts';

test('SQLite, ISO and offset timestamps show the same 24-hour business time', () => {
  for (const timestamp of [
    '2026-11-23 05:49:11',
    '2026-11-23T05:49:11.342Z',
    '2026-11-23T13:49:11+08:00',
    '2026-11-22T21:49:11-08:00',
  ]) {
    assert.equal(formatDisplayDateTime(timestamp), '2026-11-23 13:49:11');
  }
  assert.equal(formatDisplayDateTime('2026-11-23 06:00'), '2026-11-23 14:00:00');
  assert.equal(formatDisplayDateTime('2026-11-23 07:00'), '2026-11-23 15:00:00');
});

test('midnight rolls the date forward and uses 00:00', () => {
  assert.equal(formatDisplayDateTime('2026-11-23 16:00:00'), '2026-11-24 00:00:00');
  assert.equal(formatDisplayDateTime('2026-11-23 15:59:59'), '2026-11-23 23:59:59');
});

test('calendar dates and legacy text remain unchanged; absent fields follow the caller fallback', () => {
  assert.equal(formatDisplayDateTime('2026-11-23'), '2026-11-23');
  assert.equal(formatDisplayDateTime('2026-11-23 13:00:00 未核对'), '2026-11-23 13:00:00 未核对');
  assert.equal(formatDisplayDateTime('2026-02-31 00:00:00'), '2026-02-31 00:00:00');
  assert.equal(formatDisplayDateTime(null, '未记录'), '未记录');
  assert.equal(formatDisplayDateTime(''), '—');
});

test('elapsed-time comparisons parse UTC SQLite values without a client time zone offset', () => {
  assert.equal(parseStoredTimestamp('2026-11-23 05:49:11')?.getTime(), Date.UTC(2026, 10, 23, 5, 49, 11));
  assert.equal(parseStoredTimestamp('2026-11-23T15:49:11+10:00')?.getTime(), Date.UTC(2026, 10, 23, 5, 49, 11));
  assert.equal(parseStoredTimestamp('2026-11-23'), null);
  assert.equal(parseStoredTimestamp('2026-04-23T24:00:00Z'), null);
});

test('legacy backfilled movements keep an ambiguous local time and still convert explicit offsets', () => {
  assert.equal(formatMovementDateTime('opening_demo', '2026-11-23 13:49:11'), '2026-11-23 13:49:11');
  assert.equal(formatMovementDateTime('historical_sale_demo', '2026-11-23T05:49:11Z'), '2026-11-23 13:49:11');
  assert.equal(formatMovementDateTime('movement_demo', '2026-11-23 05:49:11'), '2026-11-23 13:49:11');
});
