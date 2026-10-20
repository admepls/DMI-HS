import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { FIRMWARE_TARGETS, getFirmwareTarget } from "../firmware-targets.mjs";
import {
  requireFirmwareTarget,
  validateReleaseMetadata,
  readTargetRelease,
  createSignedFiles
} from "../firmware-release.mjs";

test("N16R8 is recommended and keeps S3-specific offsets separate from classic ESP32", () => {
  const s3 = getFirmwareTarget("n16r8");
  assert.equal(s3.recommended, true);
  assert.equal(s3.chipFamily, "ESP32-S3");
  assert.equal(s3.memory, "16 MB flash / 8 MB PSRAM");
  assert.deepEqual(s3.offsets, { bootloader: 0, partitions: 0x8000, firmware: 0x20000 });
  assert.equal(getFirmwareTarget("esp32").offsets.bootloader, 0x1000);
  assert.equal(getFirmwareTarget("esp32").recommended, false);
  assert.ok(Object.isFrozen(s3.offsets));
});

test("only omitted hardware retains legacy default; invalid targets cannot select storage paths", () => {
  assert.equal(requireFirmwareTarget().id, "esp32");
  for (const id of ["", null, [], {}, "ESP32-S3", "../esp32", "__proto__", "constructor"]) {
    assert.equal(getFirmwareTarget(id), null);
    assert.throws(() => requireFirmwareTarget(id), /supported hardware/);
  }
});

test("legacy classic metadata works but N16R8 must explicitly identify its target", () => {
  const metadata = { version: " 1.2.3 ", published: "2026-10-20" };
  assert.equal(validateReleaseMetadata(metadata, FIRMWARE_TARGETS.esp32).target, "esp32");
  assert.throws(() => validateReleaseMetadata(metadata, FIRMWARE_TARGETS.n16r8), /selected hardware/);
  assert.throws(() => validateReleaseMetadata({ ...metadata, target: "esp32" }, FIRMWARE_TARGETS.n16r8));
  assert.throws(() => validateReleaseMetadata({ ...metadata, target: "n16r8" }, FIRMWARE_TARGETS.esp32));
  const result = validateReleaseMetadata({
    ...metadata, target: "n16r8", chipFamily: "ESP32", files: { firmware: "untrusted.bin" }
  }, FIRMWARE_TARGETS.n16r8);
  assert.equal(result.version, "1.2.3");
  assert.equal(result.chipFamily, "ESP32-S3");
  assert.equal(result.files, undefined);
});

test("unpublished N16R8 template fails closed until a real version is supplied", () => {
  const template = { target: "n16r8", version: "", published: "" };
  assert.throws(() => validateReleaseMetadata(template, FIRMWARE_TARGETS.n16r8), /no version/);
});

for (const target of Object.values(FIRMWARE_TARGETS)) {
  test(`${target.id} checked-in release metadata is ready for its matching upload`, () => {
    const path = `../../manifests/${target.releaseObject}`;
    const metadata = JSON.parse(readFileSync(new URL(path, import.meta.url)));
    assert.equal(metadata.target, target.id);
    assert.match(metadata.published, /^\d{4}-\d{2}-\d{2}$/);
    const release = validateReleaseMetadata(metadata, target);
    assert.equal(release.target, target.id);
    assert.equal(release.chipFamily, target.chipFamily);
    assert.ok(release.version.length > 0);
    const other = target.id === "n16r8" ? FIRMWARE_TARGETS.esp32 : FIRMWARE_TARGETS.n16r8;
    assert.throws(() => validateReleaseMetadata(metadata, other), /selected hardware/);
  });
}

function fakeBucket(target, missing = "") {
  const reads = [];
  const signed = [];
  const checked = [];
  return {
    reads, signed, checked,
    file(name) {
      return {
        async download() {
          reads.push(name);
          return [Buffer.from(JSON.stringify({ target: target.id, version: "1.2.3" }))];
        },
        async exists() { checked.push(name); return [name !== missing]; },
        async getSignedUrl(options) {
          signed.push({ name, options });
          return [`https://storage.googleapis.com/test/${name}?signature=test`];
        }
      };
    }
  };
}

for (const target of Object.values(FIRMWARE_TARGETS)) {
  test(`${target.id} reads and signs only its allowlisted release objects`, async () => {
    const bucket = fakeBucket(target);
    const release = await readTargetRelease(bucket, target);
    assert.equal(release.target, target.id);
    assert.deepEqual(bucket.reads, [target.releaseObject]);
    assert.deepEqual(bucket.checked.sort(), Object.values(target.files).sort());
    const expiresAt = new Date("2026-10-20T12:00:00Z");
    const files = await createSignedFiles(bucket, target, expiresAt);
    assert.deepEqual(bucket.signed.map((item) => item.name).sort(), Object.values(target.files).sort());
    assert.equal(files.firmware, `https://storage.googleapis.com/test/${target.files.firmware}?signature=test`);
    for (const item of bucket.signed) {
      assert.deepEqual(item.options, { version: "v4", action: "read", expires: expiresAt });
    }
  });
}

test("missing N16R8 artifacts reject preparation without falling back to root files", async () => {
  const target = FIRMWARE_TARGETS.n16r8;
  const bucket = fakeBucket(target, target.files.firmware);
  await assert.rejects(readTargetRelease(bucket, target), /missing firmware files/);
  assert.deepEqual(bucket.reads, ["n16r8/release.json"]);
  assert.deepEqual(bucket.signed, []);
});

const app = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
const backend = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");

function browserHarness() {
  const elements = new Map();
  class Element {
    constructor() {
      this.value = "";
      this.disabled = false;
      this.textContent = "";
      this.isConnected = true;
      this.dataset = {};
      this.classList = { add() {}, remove() {}, toggle() {} };
      this.listeners = {};
    }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    removeAttribute() {}
    querySelector() { return element("full-action"); }
  }
  function element(id) {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  }
  const revoked = [];
  let blob;
  const urls = class extends URL {
    static createObjectURL(value) { blob = value; return "blob:manifest"; }
    static revokeObjectURL(value) { revoked.push(value); }
  };
  const requested = [];
  let serverResponse;
  const context = vm.createContext({
    getFirmwareTarget,
    document: { getElementById: element, body: {} },
    HTMLElement: Element,
    MutationObserver: class { observe() {} },
    navigator: { serial: {} },
    window: { isSecureContext: true, addEventListener() {}, setInterval() {} },
    setInterval() {}, clearInterval() {},
    URL: urls, Blob, Date, console,
    config: { firebase: {}, functionsRegion: "test" },
    initializeApp: () => ({}), getAuth: () => ({}), getFunctions: () => ({}),
    onAuthStateChanged() {},
    httpsCallable: () => async (request) => {
      requested.push(request);
      return { data: serverResponse };
    },
    customElements: { whenDefined: async () => {} }
  });
  vm.runInContext(app.replace(/^import[\s\S]*?;\r?\n/gm, ""), context);
  return {
    context, element, revoked, requested,
    setResponse(value) { serverResponse = value; },
    manifest: async () => JSON.parse(await blob.text()),
    run: (code) => vm.runInContext(code, context),
    select(id) { element("hardware-select").value = id; context.changeHardware(); }
  };
}

function releaseResponse(target = "n16r8") {
  return {
    target,
    chipFamily: getFirmwareTarget(target).chipFamily,
    version: "1.2.3",
    expiresAt: new Date(Date.now() + 180000).toISOString(),
    grantId: "20261020-12345678-1234-4123-8123-123456789abc",
    files: Object.fromEntries(["bootloader", "partitions", "firmware"].map(
      (name) => [name, `https://storage.googleapis.com/test/${target}/${name}.bin?signature=test`]
    ))
  };
}

test("browser requires a hardware choice before preparing", async () => {
  const h = browserHarness();
  h.run('currentUser = { uid: "owner" }; refreshAccessClock();');
  assert.equal(h.element("prepare-button").disabled, true);
  await h.context.prepareInstaller();
  assert.equal(h.requested.length, 0);
  h.select("n16r8");
  assert.equal(h.element("prepare-button").disabled, false);
});

for (const target of Object.values(FIRMWARE_TARGETS)) {
  test(`browser prepares ${target.id} and builds only the correct chip family and offsets`, async () => {
    const h = browserHarness();
    h.run('currentUser = { uid: "owner" };');
    h.select(target.id);
    h.setResponse(releaseResponse(target.id));
    await h.context.prepareInstaller();
    assert.equal(h.requested[0].target, target.id);
    assert.equal(h.element("full-action").disabled, false);
    const manifest = await h.manifest();
    assert.equal(manifest.builds.length, 1);
    assert.equal(manifest.builds[0].chipFamily, target.chipFamily);
    assert.deepEqual(manifest.builds[0].parts.map((part) => part.offset), Object.values(target.offsets));
    assert.match(h.element("release-target").textContent, new RegExp(target.label));
  });
}

test("browser refuses wrong-family and old-backend releases for N16R8", () => {
  const h = browserHarness();
  const { target, chipFamily, ...oldResponse } = releaseResponse("esp32");
  assert.throws(() => h.context.validateRelease(oldResponse, "n16r8"), /selected hardware/);
  assert.throws(() => h.context.validateRelease(releaseResponse("esp32"), "n16r8"), /selected hardware/);
  assert.throws(() => h.context.validateRelease({ ...releaseResponse(), chipFamily: "ESP32" }, "n16r8"));
  assert.equal(h.context.validateRelease(oldResponse, "esp32").chipFamily, "ESP32");
});

test("mismatched server response leaves installation locked with an actionable error", async () => {
  const h = browserHarness();
  h.run('currentUser = { uid: "owner" };');
  h.select("n16r8");
  h.setResponse(releaseResponse("esp32"));
  await h.context.prepareInstaller();
  assert.equal(h.element("full-action").disabled, true);
  assert.match(h.element("release-error").textContent, /Nothing will be flashed/);
});

test("changing hardware invalidates prepared links, metadata, and the installation context", async () => {
  const h = browserHarness();
  h.run('currentUser = { uid: "owner" };');
  h.select("n16r8");
  h.setResponse(releaseResponse());
  await h.context.prepareInstaller();
  h.select("esp32");
  assert.equal(h.element("full-install-button").manifest, "");
  assert.deepEqual(h.revoked, ["blob:manifest"]);
  assert.equal(h.element("full-action").disabled, true);
  assert.equal(h.run("preparedReleaseContext"), null);
  assert.equal(h.element("release-version").textContent, "Protected");
  assert.equal(h.element("prepare-button").disabled, false);
});

test("hardware and prepare controls stay locked while a flash dialog is open, even after expiry", () => {
  const h = browserHarness();
  h.run('currentUser = { uid: "owner" };');
  h.select("n16r8");
  h.run("activeInstallDialog = { isConnected: true }; syncHardwareControls();");
  assert.equal(h.element("hardware-select").disabled, true);
  assert.equal(h.element("sign-out-button").disabled, true);
  h.select("esp32");
  assert.equal(h.element("hardware-select").value, "n16r8");
  h.context.lockRelease("Expired");
  h.context.refreshAccessClock();
  assert.equal(h.element("prepare-button").disabled, true);
  h.run("activeInstallDialog = null; syncHardwareControls(); refreshAccessClock();");
  assert.equal(h.element("hardware-select").disabled, false);
  assert.equal(h.element("prepare-button").disabled, false);
});

test("hardware cannot change during a preparation request", () => {
  const h = browserHarness();
  h.select("n16r8");
  h.context.setAuthBusy(true);
  h.select("esp32");
  assert.equal(h.run("selectedTargetId"), "n16r8");
  assert.equal(h.element("hardware-select").disabled, true);
});

test("backend binds release, signing, and install grant to its validated target", () => {
  assert.match(backend, /requireFirmwareTarget\(request\.data\?\.target\)/);
  assert.match(backend, /readRelease\(bucket, target\)/);
  assert.match(backend, /createSignedFiles\(bucket, target, expiresAt\)/);
  assert.match(backend, /target: release\.target/);
});

test("Pages stages the public shared catalog without publishing the server directory", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/pages.yml", import.meta.url), "utf8");
  assert.match(workflow, /cp functions\/firmware-targets\.mjs _site\/functions\//);
  assert.doesNotMatch(workflow, /cp\s+-R\s+functions/);
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(html, /value="n16r8">ESP32-S3 N16R8 — Recommended/);
  assert.match(html, /value="esp32">Classic ESP32/);
});
