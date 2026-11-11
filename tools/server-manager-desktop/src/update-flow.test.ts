import assert from "node:assert/strict";
import test from "node:test";
import {
  FAILED_STEP_INDEX,
  UPDATE_STEPS,
  getTerminalStatuses,
  getUpdateProgress,
} from "./update-flow";

test("the initial update state has a completed preflight and pending maintenance steps", () => {
  const statuses = getUpdateProgress(1);

  assert.equal(statuses[0], "complete");
  assert.equal(statuses[1], "pending");
  assert.equal(statuses.length, 9);
});

test("a build failure blocks service startup and health checks", () => {
  const statuses = getTerminalStatuses("build-failure");

  assert.equal(statuses[FAILED_STEP_INDEX], "failed");
  assert.deepEqual(statuses.slice(FAILED_STEP_INDEX + 1), ["skipped", "skipped"]);
  assert.equal(UPDATE_STEPS[7].key, "start");
  assert.equal(UPDATE_STEPS[8].key, "health");
});

test("a successful update completes every step", () => {
  assert.ok(getTerminalStatuses("success").every((status) => status === "complete"));
});

test("progress does not mark later steps complete while a step is running", () => {
  const statuses = getUpdateProgress(6, FAILED_STEP_INDEX);

  assert.equal(statuses[FAILED_STEP_INDEX], "running");
  assert.equal(statuses[FAILED_STEP_INDEX + 1], "pending");
});
