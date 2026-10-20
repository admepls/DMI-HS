import assert from "node:assert/strict";
import test from "node:test";
import { canonicalIpNetwork, requestIpKey, applyIpRequestLimit, createIpRequestGuard, withIpRequestLimit } from "../ip-rate-limit.mjs";

const date = new Date("2026-10-08T04:30:20Z");
const limits = { perIpMinute: 2, perIpHour: 3, perIpDay: 4, globalDay: 6 };
const request = (ip = "198.51.100.7") => ({ rawRequest: { headers: { "x-forwarded-for": ip } } });
const options = { ...limits, ipKey: "ip-a", now: date };

test("normalizes IPv4 and mapped IPv6 and groups native IPv6 by /64", () => {
  assert.equal(canonicalIpNetwork("198.51.100.7"), "v4:198.51.100.7");
  assert.equal(canonicalIpNetwork("::ffff:198.51.100.7"), "v4:198.51.100.7");
  assert.equal(canonicalIpNetwork("::FFFF:c633:6407"), "v4:198.51.100.7");
  assert.equal(canonicalIpNetwork("2001:0DB8:0000:0001::1"), "v6:2001:db8:0:1/64");
  assert.equal(canonicalIpNetwork("2001:db8:0:1::abcd"), "v6:2001:db8:0:1/64");
  assert.notEqual(canonicalIpNetwork("2001:db8:0:2::1"), "v6:2001:db8:0:1/64");
  for (const value of [null, "", "unknown", "198.51.100.7:1234", "fe80::1%eth0", "999.1.1.1", "[::1]"]) {
    assert.equal(canonicalIpNetwork(value), null);
  }
});

test("caller-controlled IP fields and XFF prefix cannot change direct-ingress identity", () => {
  const trusted = requestIpKey(request().rawRequest, "20261008");
  const spoofed = request("1.2.3.4, 198.51.100.7").rawRequest;
  spoofed.ip = "5.6.7.8";
  spoofed.headers["x-real-ip"] = "5.6.7.8";
  spoofed.headers["cf-connecting-ip"] = "5.6.7.8";
  assert.equal(requestIpKey(spoofed, "20261008"), trusted);
  assert.match(trusted, /^[a-f0-9]{64}$/);
  assert.notEqual(requestIpKey(spoofed, "20261009"), trusted);
  assert.equal(requestIpKey(request("::ffff:198.51.100.7").rawRequest, "20261008"), trusted);
});

test("fails closed for missing/invalid addresses and ambiguous header types", () => {
  for (const forwarded of [undefined, "", "1.2.3.4,invalid", ["1.2.3.4"], "x".repeat(2049)]) {
    assert.equal(requestIpKey({ headers: { "x-forwarded-for": forwarded }, ip: "1.2.3.4" }, "20261008"), null);
  }
  assert.equal(requestIpKey(request().rawRequest, "20261008", { trustedHops: 2 }), null);
  assert.equal(requestIpKey(request().rawRequest, "20261008", { trustedHops: 0 }), null);
  assert.ok(requestIpKey({ socket: { remoteAddress: "127.0.0.1" } }, "20261008", { emulator: true }));
});

test("explicit verified two-hop ingress selects the client, not a spoofed prefix", () => {
  assert.equal(
    requestIpKey(request("spoof,198.51.100.7,203.0.113.10").rawRequest, "20261008", { trustedHops: 2 }),
    requestIpKey(request().rawRequest, "20261008")
  );
});

test("minute, hour and day quotas reset only at their UTC boundaries", () => {
  let state = applyIpRequestLimit(null, options).state;
  state = applyIpRequestLimit(state, options).state;
  assert.deepEqual(applyIpRequestLimit(state, options), { allowed: false, scope: "ip-minute", retryAfterSeconds: 40 });
  const later = { ...options, now: new Date("2026-10-08T04:31:00Z") };
  state = applyIpRequestLimit(state, later).state;
  assert.equal(applyIpRequestLimit(state, later).scope, "ip-hour");
  const nextHour = { ...options, now: new Date("2026-10-08T05:00:00Z") };
  state = applyIpRequestLimit(state, nextHour).state;
  assert.equal(applyIpRequestLimit(state, nextHour).scope, "ip-day");
  assert.equal(applyIpRequestLimit(null, { ...options, now: new Date("2026-10-09T00:00:00Z") }).allowed, true);
});

test("one IP does not consume another IP's quota; global daily admission stops all IPs", () => {
  let state;
  for (let i = 0; i < 6; i++) state = applyIpRequestLimit(state, { ...options, ipKey: `ip-${i}` }).state;
  assert.equal(applyIpRequestLimit(state, { ...options, ipKey: "new-ip" }).scope, "request-global-day");
});

test("a delayed old-window request cannot roll counters back", () => {
  const newer = { ...options, now: new Date("2026-10-08T05:31:00Z") };
  let state = applyIpRequestLimit(null, newer).state;
  state = applyIpRequestLimit(state, newer).state;
  const original = structuredClone(state);
  assert.equal(applyIpRequestLimit(state, options).allowed, false);
  assert.deepEqual(state, original);
});

function sharedStore() {
  const days = new Map();
  let queue = Promise.resolve();
  let calls = 0;
  const transact = (day, update) => {
    calls++;
    const pending = queue.then(() => {
      // Simulate the initial null cache followed by an authoritative retry.
      update(null);
      const proposed = update(days.get(day));
      if (proposed === undefined) return { committed: false };
      days.set(day, proposed);
      return { committed: true };
    });
    queue = pending.catch(() => {});
    return pending;
  };
  return { transact, days, calls: () => calls };
}

test("concurrent requests across instances/cold starts share the same atomic allowance", async () => {
  const db = sharedStore();
  const create = () => createIpRequestGuard({ transact: db.transact, limits, clock: () => date });
  const instances = [create(), create()];
  const outcomes = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => instances[i % 2](request())));
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 2);
  await assert.rejects(create()(request()), (e) => e.code === "resource-exhausted" && e.details.retryable === true);
});

test("cached rejections skip database work until reset; allowed calls are never cached", async () => {
  const db = sharedStore();
  let now = date;
  const guard = createIpRequestGuard({ transact: db.transact, limits, clock: () => now });
  await guard(request()); await guard(request());
  await assert.rejects(guard(request()), { code: "resource-exhausted" });
  const before = db.calls();
  await assert.rejects(guard(request()), { code: "resource-exhausted" });
  assert.equal(db.calls(), before);
  now = new Date("2026-10-08T04:31:00Z");
  await guard(request());
  assert.equal(db.calls(), before + 1);
});

test("global daily block is cached across different IPs", async () => {
  const db = sharedStore();
  const guard = createIpRequestGuard({ transact: db.transact, limits: { ...limits, globalDay: 1 }, clock: () => date });
  await guard(request());
  await assert.rejects(guard(request("203.0.113.1")), { code: "resource-exhausted" });
  const before = db.calls();
  await assert.rejects(guard(request("203.0.113.2")), { code: "resource-exhausted" });
  assert.equal(db.calls(), before);
});

test("database failure or an uncommitted admission never calls the protected handler", async () => {
  for (const transact of [async () => { throw new Error("offline"); }, async (_, update) => { update(null); return { committed: false }; }]) {
    let reached = false;
    const guard = createIpRequestGuard({ transact, limits, clock: () => date });
    const wrapped = withIpRequestLimit(guard, () => { reached = true; });
    await assert.rejects(wrapped(request()), { code: "unavailable" });
    assert.equal(reached, false);
  }
});

test("denied requests never reach auth, storage, signing or metrics work", async () => {
  const db = sharedStore();
  const guard = createIpRequestGuard({ transact: db.transact, limits: { ...limits, perIpMinute: 1 }, clock: () => date });
  let reached = 0;
  const wrapped = withIpRequestLimit(guard, (_, network) => { reached++; return network; });
  const first = await wrapped(request());
  assert.equal(first.dayKey, "20261008");
  assert.equal(first.now, date);
  await assert.rejects(wrapped(request()), { code: "resource-exhausted" });
  assert.equal(reached, 1);
});
