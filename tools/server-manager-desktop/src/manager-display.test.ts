import assert from "node:assert/strict";
import test from "node:test";
import {
  databaseIntegrityLabel,
  formatBeijingDate,
  formatDateInTimeZone,
  maintenanceAccess,
  operationKindLabel,
  operationStageLabel,
  operationStateLabel,
  pausesUpdaterPolling,
  serviceHealthLabel,
  serviceStateLabel,
  timeZoneLabel,
} from "./manager-display";

test("maintenance timestamps use Beijing time and the 24-hour clock", () => {
  assert.equal(formatBeijingDate(Date.parse("2026-11-27T05:14:15Z") / 1000), "2026-11-27 13:14:15");
  assert.equal(formatBeijingDate(null), "时间未记录");
  assert.equal(formatDateInTimeZone(Date.parse("2026-11-27T05:14:15Z") / 1000, "UTC"), "2026-11-27 05:14:15");
  assert.equal(timeZoneLabel("Asia/Shanghai"), "北京时间");
  assert.equal(timeZoneLabel("UTC"), "UTC");
  assert.equal(formatDateInTimeZone(1, "Unknown/Zone"), "时间未记录");
});

test("service process and business health are not conflated", () => {
  assert.equal(serviceStateLabel("running"), "运行中");
  assert.equal(serviceHealthLabel("running", false), "进程运行，业务健康检查未通过");
  assert.equal(serviceHealthLabel("running", true), "业务健康检查通过");
  assert.equal(serviceStateLabel("starting"), "启动中");
});

test("unknown database integrity remains unverified", () => {
  assert.equal(databaseIntegrityLabel("unknown"), "完整性尚未核验");
  assert.equal(databaseIntegrityLabel("ok"), "完整性检查通过");
  assert.equal(databaseIntegrityLabel("failed"), "完整性检查未通过");
});

test("maintenance actions require both dashboard and updater permission and intact history", () => {
  assert.equal(maintenanceAccess(true, true, null), true);
  assert.equal(maintenanceAccess(true, undefined, null), true);
  assert.equal(maintenanceAccess(false, true, null), false);
  assert.equal(maintenanceAccess(true, false, null), false);
  assert.equal(maintenanceAccess(true, true, "history write failed"), false);
});

test("long database reads pause status polling without hiding update progress", () => {
  assert.equal(pausesUpdaterPolling("database-check"), true);
  assert.equal(pausesUpdaterPolling("backup-export"), true);
  assert.equal(pausesUpdaterPolling("backup"), false);
  assert.equal(pausesUpdaterPolling("online"), false);
});

test("maintenance history uses clear localized operation, stage, and outcome labels", () => {
  assert.equal(operationKindLabel("automatic_backup"), "自动备份");
  assert.equal(operationKindLabel("inventory_update"), "库存版本更新");
  assert.equal(operationStateLabel("recovered"), "中断待核实");
  assert.equal(operationStateLabel("failed"), "失败");
  assert.equal(operationStageLabel("migrating"), "迁移测试副本");
  assert.equal(operationStageLabel("unknown"), "处理中");
});
