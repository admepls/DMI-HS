import assert from "node:assert/strict";
import test from "node:test";
import { applyRateLimit, utcWindowKeys } from "../rate-limit.mjs";

const options = {
  uidKey: "user-a",
  hourKey: "12",
  nowMs: Date.UTC(2026, 8, 1, 12),
  perUserHour: 3,
  perUserDay: 10,
  globalDay: 30,
  retryAfterHour: 1800,
  retryAfterDay: 36000
};

test("allows a request and returns remaining quotas", () => {
  const result = applyRateLimit(null, options);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.remaining, { userHour: 2, userDay: 9, globalDay: 29 });
  assert.equal(result.state.users["user-a"].hours["12"], 1);
});

test("blocks the fourth request in the same hour", () => {
  let state = null;
  for (let count = 0; count < 3; count += 1) {
    state = applyRateLimit(state, options).state;
  }
  const result = applyRateLimit(state, options);
  assert.deepEqual(result, {
    allowed: false,
    scope: "user-hour",
    retryAfterSeconds: 1800
  });
});

test("blocks the global daily quota", () => {
  const result = applyRateLimit(
    { globalCount: 30 },
    { ...options, uidKey: "another-user" }
  );
  assert.equal(result.allowed, false);
  assert.equal(result.scope, "global-day");
});

test("builds UTC rate-limit window keys", () => {
  assert.deepEqual(utcWindowKeys(new Date("2026-09-01T07:45:00Z")), {
    dayKey: "20260901",
    hourKey: "07"
  });
});
