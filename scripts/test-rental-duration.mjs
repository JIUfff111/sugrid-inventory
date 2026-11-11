import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addRentalDays,
  addRentalMonths,
  calculateRentalDuration,
  isValidRentalDate,
} from '../src/lib/rental-duration.ts';

test('day duration counts elapsed days and does not bill the start date twice', () => {
  assert.equal(calculateRentalDuration('2026-11-11', '2026-11-12', 'day'), 1);
  assert.equal(calculateRentalDuration('2026-11-11', '2026-11-14', 'day'), 3);
  assert.equal(addRentalDays('2026-11-11', 1), '2026-11-12');
  assert.equal(calculateRentalDuration('2026-11-11', '2026-11-11', 'day'), 0);
});

test('month duration counts completed calendar-month terms', () => {
  assert.equal(calculateRentalDuration('2026-11-11', '2026-12-11', 'month'), 1);
  assert.equal(calculateRentalDuration('2026-11-11', '2026-12-10', 'month'), 0);
  assert.equal(calculateRentalDuration('2026-11-11', '2026-12-12', 'month'), 1);
  assert.equal(calculateRentalDuration('2026-11-11', '2027-01-11', 'month'), 2);
  assert.equal(addRentalMonths('2026-11-11', 2), '2027-01-11');
});

test('month-end additions clamp to the target month and keep the original anchor day', () => {
  assert.equal(addRentalMonths('2027-01-31', 1), '2027-02-28');
  assert.equal(addRentalMonths('2027-01-31', 2), '2027-03-31');
  assert.equal(calculateRentalDuration('2027-01-31', '2027-02-28', 'month'), 1);
  assert.equal(calculateRentalDuration('2027-01-31', '2027-03-30', 'month'), 1);
  assert.equal(calculateRentalDuration('2027-01-31', '2027-03-31', 'month'), 2);
});

test('invalid, reversed, and zero-length terms are not billable', () => {
  assert.equal(isValidRentalDate('2026-02-29'), false);
  assert.equal(calculateRentalDuration('2026-11-12', '2026-11-11', 'day'), 0);
  assert.equal(calculateRentalDuration('bad-date', '2026-11-12', 'day'), 0);
  assert.equal(addRentalDays('bad-date', 3), null);
});
