import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const backend = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");
const app = readFileSync(new URL("../../app.js", import.meta.url), "utf8");

test("both production callables use the shared IP guard before their handler", () => {
  const release = backend.slice(backend.indexOf("export const getFirmwareRelease"), backend.indexOf("export const recordFirmwareInstall"));
  const report = backend.slice(backend.indexOf("export const recordFirmwareInstall"));
  for (const code of [release, report]) {
    assert.ok(code.indexOf("withIpRequestLimit(enforceIpRequests") >= 0);
    assert.ok(code.indexOf("withIpRequestLimit(enforceIpRequests") < code.indexOf("requireApprovedInstaller(request)"));
  }
  assert.ok(release.indexOf("readRelease(bucket, target)") >= 0);
  assert.ok(release.indexOf("enforceRateLimit(installer.uid, network.ipKey, now)") < release.indexOf("readRelease(bucket, target)"));
  assert.ok(release.includes("const now = network.now;"));
  assert.match(backend, /transaction\(update, undefined, false\)/);
});

const reportCode = app.slice(app.indexOf("function isPermanentInstallReportError"), app.indexOf("function armInstallAttempt"));
function frontendHarness(error) {
  const reports = [{ uid: "user-a", attemptId: "attempt-1" }, { uid: "user-a", attemptId: "attempt-2" }];
  const stored = [];
  let calls = 0;
  const context = vm.createContext({
    Date, Number, Set,
    installReportFlushInFlight: false, installReportRetryAt: 0, currentUser: { uid: "user-a" },
    readPendingInstallReports: () => reports,
    writePendingInstallReports: (next) => stored.push([...next]),
    reportSuccessfulInstall: async () => { calls++; throw error; },
    setAccessStatus: () => {}, console: { warn: () => {} }
  });
  vm.runInContext(reportCode, context);
  return { context, stored, reports, calls: () => calls };
}

test("temporary IP throttling retains current and later reports and respects cooldown", async () => {
  const h = frontendHarness({ code: "functions/resource-exhausted", details: { retryable: true, retryAfterSeconds: 60 } });
  await h.context.flushPendingInstallReports();
  assert.equal(h.calls(), 1);
  assert.deepEqual(h.stored[0], h.reports);
  assert.ok(h.context.installReportRetryAt > Date.now());
  assert.equal(h.context.installReportFlushInFlight, false);
  await h.context.flushPendingInstallReports();
  assert.equal(h.calls(), 1);
});

test("permanent grant exhaustion is still discarded rather than retried forever", async () => {
  const h = frontendHarness({ code: "functions/resource-exhausted" });
  await h.context.flushPendingInstallReports();
  assert.equal(h.calls(), 2);
  assert.equal(h.stored[0].length, 0);
});

test("transient backend errors keep reports; malformed cooldown cannot create an infinite wait", async () => {
  const h = frontendHarness({ code: "functions/unavailable" });
  await h.context.flushPendingInstallReports();
  assert.deepEqual(h.stored[0], h.reports);
  const limited = frontendHarness({ code: "functions/resource-exhausted", details: { retryable: true, retryAfterSeconds: "Infinity" } });
  await limited.context.flushPendingInstallReports();
  assert.ok(Number.isFinite(limited.context.installReportRetryAt));
});
