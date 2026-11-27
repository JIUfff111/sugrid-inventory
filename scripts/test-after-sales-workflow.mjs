import assert from 'node:assert/strict';
import test from 'node:test';
import { getAfterSalesWorkflow, needsAfterSalesOriginalDisposition } from '../src/lib/after-sales-workflow.ts';

test('a signed-in repair shows its next action separately from the stored machine', () => {
  const read = getAfterSalesWorkflow({ resolutionType: 'repair', status: 'received', stockStatus: 'stored',
    stockReceivedAt: '2026-11-27 13:10:00', receivedByName: '收件人' });
  assert.deepEqual([read.typeLabel, read.label, read.machineLocation, read.action], ['维修', '待维修', '在售后暂存', '开始维修']);
  assert.equal(read.at, '2026-11-27 13:10:00');
  assert.equal(read.by, '收件人');
  const repairing = getAfterSalesWorkflow({ resolutionType: 'repair', status: 'processing', stockStatus: 'stored' });
  assert.equal(repairing.stage, 'repairing');
  assert.match(repairing.instruction, /实际归还客户后/);
  assert.equal(getAfterSalesWorkflow({ resolutionType: 'repair', status: 'resolved', stockStatus: 'released' }).machineLocation, '已归还客户');
});

test('exchange reservation and shipment do not move the original into regular inventory', () => {
  const exchange = { resolutionType: 'exchange', stockStatus: 'stored' };
  assert.equal(getAfterSalesWorkflow({ ...exchange, status: 'received' }).stage, 'awaiting_replacement');
  const reserved = getAfterSalesWorkflow({ ...exchange, status: 'processing', reservedReplacementId: 'replacement-id' });
  assert.equal(reserved.stage, 'awaiting_shipment');
  assert.match(reserved.instruction, /只会将替换机出库/);
  const shipped = { ...exchange, status: 'resolved', replacementInventoryId: 'replacement-id' };
  assert.equal(needsAfterSalesOriginalDisposition(shipped), true);
  const awaitingInspection = getAfterSalesWorkflow(shipped);
  assert.equal(awaitingInspection.stage, 'awaiting_original_disposition');
  assert.equal(awaitingInspection.machineLocation, '在售后暂存');
  assert.match(awaitingInspection.instruction, /只有检查合格后/);
  const restocked = { ...shipped, stockStatus: 'restocked' };
  assert.equal(needsAfterSalesOriginalDisposition(restocked), false);
  assert.equal(getAfterSalesWorkflow(restocked).machineLocation, '已转正式库存');
});

test('a historical open refund is distinguished from an immediately completed return', () => {
  const refund = { resolutionType: 'customer_return' };
  assert.equal(getAfterSalesWorkflow({ ...refund, status: 'received', stockStatus: 'stored' }).stage, 'awaiting_refund_review');
  const processing = getAfterSalesWorkflow({ ...refund, status: 'processing', stockStatus: 'stored' });
  assert.equal(processing.stage, 'awaiting_refund_completion');
  assert.match(processing.instruction, /原渠道完成退款后/);
  assert.equal(processing.machineLocation, '在售后暂存');
  const completed = getAfterSalesWorkflow({ ...refund, status: 'resolved' });
  assert.equal(completed.stage, 'resolved');
  assert.equal(completed.machineLocation, '已转正式库存');
});

test('missing or cancelled historical records do not imply a known physical destination', () => {
  const unknown = getAfterSalesWorkflow({ resolutionType: 'legacy_unknown', status: 'legacy_state' });
  assert.deepEqual([unknown.typeLabel, unknown.label, unknown.machineLocation], ['类型未记录', '进度未记录', '机器去向未记录']);
  const cancelled = getAfterSalesWorkflow({ resolutionType: 'repair', status: 'cancelled', stockStatus: 'released',
    receivedAt: '2026-11-27 13:10:00' });
  assert.equal(cancelled.machineLocation, '已解除暂存，去向未记录');
  assert.equal(getAfterSalesWorkflow({ resolutionType: 'repair', status: 'created' }).machineLocation, '尚未签收');
});
