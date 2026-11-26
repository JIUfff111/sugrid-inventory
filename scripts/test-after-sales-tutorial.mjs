import assert from 'node:assert/strict';
import test from 'node:test';
import { afterSalesTutorialKey, canAutoShowAfterSalesTutorial } from '../src/lib/after-sales-tutorial-preference.ts';

test('dismissing one account and version does not suppress another account or version', () => {
  const preferences = new Map([[afterSalesTutorialKey('qa-a'), 'seen']]);
  assert.equal(preferences.get(afterSalesTutorialKey('qa-a')), 'seen');
  assert.equal(preferences.has(afterSalesTutorialKey('qa-b')), false);
  assert.equal(preferences.has(afterSalesTutorialKey('qa-a', 2)), false);
});

test('auto-opening only applies to the active workspace, without a linked order or another dialog', () => {
  const ordinaryEntry = { active: true, userId: 'qa-a', linkedRecord: false, busy: false };
  assert.equal(canAutoShowAfterSalesTutorial(ordinaryEntry), true);
  assert.equal(canAutoShowAfterSalesTutorial({ ...ordinaryEntry, active: false }), false);
  assert.equal(canAutoShowAfterSalesTutorial({ ...ordinaryEntry, userId: undefined }), false);
  assert.equal(canAutoShowAfterSalesTutorial({ ...ordinaryEntry, linkedRecord: true }), false);
  assert.equal(canAutoShowAfterSalesTutorial({ ...ordinaryEntry, busy: true }), false);
});
