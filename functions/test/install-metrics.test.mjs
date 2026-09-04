import assert from "node:assert/strict";
import test from "node:test";
import {
  applySuccessfulInstall,
  safeVersionKey
} from "../install-metrics.mjs";

const nowMs = Date.UTC(2026, 8, 4, 6, 30);
const baseState = () => ({
  grants: {
    "20260904": {
      "20260904-grant-a": {
        uidKey: "owner-a",
        version: "1.2.3",
        reportByMs: nowMs + 60_000,
        successCount: 0
      }
    }
  }
});

const options = {
  grantDayKey: "20260904",
  successDayKey: "20260904",
  grantId: "20260904-grant-a",
  uidKey: "owner-a",
  attemptId: "attempt-a",
  operation: "full-install",
  nowMs,
  maxSuccessesPerGrant: 5
};

test("counts a successful full installation", () => {
  const result = applySuccessfulInstall(baseState(), options);
  assert.equal(result.accepted, true);
  assert.equal(result.duplicate, false);
  assert.deepEqual(result.counts, {
    fullInstall: 1,
    firmwareUpdate: 0,
    total: 1
  });
  assert.equal(result.state.daily["20260904"].fullInstall, 1);
  assert.equal(result.state.versions["1_2_3"].fullInstall, 1);
  assert.equal(result.state.versions["1_2_3"].label, "1.2.3");
});

test("counts a firmware update separately", () => {
  const result = applySuccessfulInstall(baseState(), {
    ...options,
    operation: "firmware-update"
  });
  assert.deepEqual(result.counts, {
    fullInstall: 0,
    firmwareUpdate: 1,
    total: 1
  });
});

test("does not count the same attempt twice", () => {
  const first = applySuccessfulInstall(baseState(), options);
  const second = applySuccessfulInstall(first.state, options);
  assert.equal(second.accepted, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.counts.total, 1);
});

test("rejects an expired or wrong-owner grant", () => {
  const expired = applySuccessfulInstall(baseState(), {
    ...options,
    nowMs: nowMs + 120_000
  });
  const wrongOwner = applySuccessfulInstall(baseState(), {
    ...options,
    uidKey: "owner-b"
  });
  assert.equal(expired.reason, "grant-expired");
  assert.equal(wrongOwner.reason, "grant-owner-mismatch");
});

test("limits success reports issued from one grant", () => {
  const state = baseState();
  state.grants["20260904"]["20260904-grant-a"].successCount = 5;
  const result = applySuccessfulInstall(state, options);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "grant-limit");
});

test("normalizes version names for Realtime Database keys", () => {
  assert.equal(safeVersionKey(" release/1.2#[test]$ "), "release_1_2__test__");
});
