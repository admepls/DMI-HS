import assert from "node:assert/strict";
import test from "node:test";
import { applyRateLimit, utcWindowKeys } from "../rate-limit.mjs";

const options = {
  uidKey: "user-a",
  ipKey: "network-a",
  perIpHour: 3,
  perIpDay: 10,
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

test("different accounts on the same IP share the preparation quota", () => {
  let state;
  for (let i = 0; i < 3; i++) state = applyRateLimit(state, { ...options, uidKey: `user-${i}` }).state;
  const before = structuredClone(state);
  const denied = applyRateLimit(state, { ...options, uidKey: "another-account" });
  assert.equal(denied.scope, "ip-grant-hour");
  assert.deepEqual(state, before);
  assert.equal(state.globalCount, 3);
  assert.equal(applyRateLimit(state, { ...options, uidKey: "another-account", ipKey: "another-network" }).allowed, true);
});

test("daily IP quota persists across hour and account changes", () => {
  const state = { ips: { "network-a": { dailyCount: 10, hours: { "11": 1 } } } };
  const result = applyRateLimit(state, options);
  assert.equal(result.scope, "ip-grant-day");
  assert.equal(result.retryAfterSeconds, options.retryAfterDay);
});

test("changing IP does not bypass existing account or global grant limits", () => {
  let state;
  for (let i = 0; i < 3; i++) state = applyRateLimit(state, { ...options, ipKey: `network-${i}` }).state;
  assert.equal(applyRateLimit(state, { ...options, ipKey: "another-network" }).scope, "user-hour");
  assert.equal(applyRateLimit({ globalCount: 30 }, { ...options, ipKey: "new-network", uidKey: "new-account" }).scope, "global-day");
});

test("existing pre-IP counters are retained and missing IP configuration fails closed", () => {
  const legacy = { globalCount: 1, users: { "user-a": { dailyCount: 1, hours: { "12": 1 } } } };
  const result = applyRateLimit(legacy, options);
  assert.equal(result.state.globalCount, 2);
  assert.equal(result.state.users["user-a"].dailyCount, 2);
  assert.equal(result.state.ips["network-a"].dailyCount, 1);
  assert.throws(() => applyRateLimit(null, { ...options, ipKey: undefined }));
  assert.throws(() => applyRateLimit(null, { ...options, perIpHour: undefined }));
});
