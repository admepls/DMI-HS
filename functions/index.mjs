import { createHash, randomUUID } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { logger } from "firebase-functions";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { Storage } from "@google-cloud/storage";
import {
  applyRateLimit,
  secondsUntilNextUtcDay,
  secondsUntilNextUtcHour,
  utcWindowKeys
} from "./rate-limit.mjs";
import {
  applySuccessfulInstall
} from "./install-metrics.mjs";

initializeApp();
const cloudStorage = new Storage();

const REGION = "asia-southeast1";
const BUCKET_NAME = "dmi-hs.firebasestorage.app";
const RELEASE_OBJECT = "release.json";
const INSTALL_METRICS_PATH = "firmwareInstallerInstallMetrics";
const INSTALL_REPORT_GRACE_MS = 15 * 60 * 1000;
const MAX_SUCCESSES_PER_GRANT = 5;
const FIRMWARE_OBJECTS = Object.freeze({
  bootloader: "bootloader.bin",
  partitions: "partitions.bin",
  firmware: "firmware.bin"
});

function integerSetting(name, fallback, minimum, maximum) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function booleanSetting(name, fallback = false) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function approvedEmails() {
  return new Set(
    String(process.env.INSTALLER_EMAILS || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

function requireApprovedInstaller(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in before preparing the installer.");
  }

  if (booleanSetting("ENFORCE_APP_CHECK") && !request.app) {
    throw new HttpsError(
      "failed-precondition",
      "App verification is required. Reload the official installer page."
    );
  }

  const token = request.auth.token || {};
  const email = typeof token.email === "string" ? token.email.toLowerCase() : "";
  const claimApproved = token.firmwareInstaller === true;
  const emailApproved =
    token.email_verified === true && email !== "" && approvedEmails().has(email);

  if (!claimApproved && !emailApproved) {
    logger.warn("Firmware access rejected", {
      uid: request.auth.uid,
      email,
      appCheck: Boolean(request.app)
    });
    throw new HttpsError(
      "permission-denied",
      "This account is not approved to install DMI-HS firmware."
    );
  }

  return { uid: request.auth.uid, email };
}

function installerUidKey(uid) {
  return createHash("sha256").update(uid).digest("hex").slice(0, 32);
}

function validateRelease(value) {
  if (!value || typeof value !== "object") {
    throw new Error("release.json is not an object");
  }
  if (typeof value.version !== "string" || value.version.trim() === "") {
    throw new Error("release.json has no version");
  }
  return {
    version: value.version.trim(),
    published:
      typeof value.published === "string" && value.published.trim() !== ""
        ? value.published.trim()
        : "Not specified"
  };
}

async function readRelease(bucket) {
  try {
    const [contents] = await bucket.file(RELEASE_OBJECT).download();
    return validateRelease(JSON.parse(contents.toString("utf8")));
  } catch (error) {
    logger.error("Protected release could not be read", error);
    throw new HttpsError(
      "failed-precondition",
      "The firmware release is not ready. Contact the operator."
    );
  }
}

async function enforceRateLimit(uid, now) {
  const perUserHour = integerSetting("LIMIT_PER_USER_HOUR", 3, 1, 50);
  const perUserDay = integerSetting("LIMIT_PER_USER_DAY", 10, 1, 200);
  const globalDay = integerSetting("LIMIT_GLOBAL_DAY", 30, 1, 1000);
  const { dayKey, hourKey } = utcWindowKeys(now);
  const uidKey = installerUidKey(uid);
  const retryAfterHour = secondsUntilNextUtcHour(now);
  const retryAfterDay = secondsUntilNextUtcDay(now);
  const limitRef = getDatabase().ref(`firmwareInstallerRateLimits/${dayKey}`);
  let decision = null;

  const result = await limitRef.transaction(
    (current) => {
      decision = applyRateLimit(current, {
        uidKey,
        hourKey,
        nowMs: now.getTime(),
        perUserHour,
        perUserDay,
        globalDay,
        retryAfterHour,
        retryAfterDay
      });
      return decision.allowed ? decision.state : undefined;
    },
    undefined,
    false
  );

  if (!result.committed || !decision?.allowed) {
    const retryAfterSeconds = decision?.retryAfterSeconds || retryAfterHour;
    throw new HttpsError(
      "resource-exhausted",
      "The secure installer request limit has been reached.",
      {
        scope: decision?.scope || "rate-limit",
        retryAfterSeconds
      }
    );
  }

  const cleanupDate = new Date(now);
  cleanupDate.setUTCDate(cleanupDate.getUTCDate() - 3);
  const { dayKey: cleanupDay } = utcWindowKeys(cleanupDate);
  void getDatabase()
    .ref(`firmwareInstallerRateLimits/${cleanupDay}`)
    .remove()
    .catch((error) => logger.warn("Rate-limit cleanup deferred", error));

  return decision.remaining;
}

async function createInstallGrant(installer, release, now, expiresAt) {
  const { dayKey } = utcWindowKeys(now);
  const grantId = `${dayKey}-${randomUUID()}`;
  const grant = {
    uidKey: installerUidKey(installer.uid),
    version: release.version,
    issuedAtMs: now.getTime(),
    expiresAtMs: expiresAt.getTime(),
    reportByMs: expiresAt.getTime() + INSTALL_REPORT_GRACE_MS,
    successCount: 0
  };
  await getDatabase()
    .ref(`${INSTALL_METRICS_PATH}/grants/${dayKey}/${grantId}`)
    .set(grant);

  const cleanupDate = new Date(now);
  cleanupDate.setUTCDate(cleanupDate.getUTCDate() - 4);
  const { dayKey: cleanupDay } = utcWindowKeys(cleanupDate);
  try {
    await cleanupInstallGrants(cleanupDay);
  } catch (error) {
    logger.warn("Install-grant cleanup deferred", error);
  }

  return grantId;
}

async function cleanupInstallGrants(lastExpiredDay) {
  const grantsRef = getDatabase().ref(`${INSTALL_METRICS_PATH}/grants`);
  const stale = await grantsRef.orderByKey().endAt(lastExpiredDay).once("value");
  if (!stale.exists()) return;
  const updates = {};
  stale.forEach((child) => {
    updates[child.key] = null;
  });
  await grantsRef.update(updates);
}

function requireReportField(value, name, pattern) {
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", `${name} is required.`);
  }
  const normalized = value.trim();
  if (!pattern.test(normalized)) {
    throw new HttpsError("invalid-argument", `${name} is invalid.`);
  }
  return normalized;
}

async function createSignedFiles(bucket, expiresAt) {
  const entries = await Promise.all(
    Object.entries(FIRMWARE_OBJECTS).map(async ([key, objectName]) => {
      const [url] = await bucket.file(objectName).getSignedUrl({
        version: "v4",
        action: "read",
        expires: expiresAt
      });
      return [key, url];
    })
  );
  return Object.fromEntries(entries);
}

export const getFirmwareRelease = onCall(
  {
    region: REGION,
    cors: ["https://admepls.github.io", /^http:\/\/localhost(?::\d+)?$/],
    memory: "256MiB",
    timeoutSeconds: 30,
    minInstances: 0,
    maxInstances: 2,
    concurrency: 10,
    invoker: "public",
    enforceAppCheck: false
  },
  async (request) => {
    const installer = requireApprovedInstaller(request);
    const bucket = cloudStorage.bucket(BUCKET_NAME);
    const release = await readRelease(bucket);
    const now = new Date();
    const remaining = await enforceRateLimit(installer.uid, now);
    const ttlSeconds = integerSetting("SIGNED_URL_TTL_SECONDS", 180, 60, 900);
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    try {
      const files = await createSignedFiles(bucket, expiresAt);
      const grantId = await createInstallGrant(
        installer,
        release,
        now,
        expiresAt
      );
      logger.info("Protected firmware release issued", {
        uid: installer.uid,
        email: installer.email,
        version: release.version,
        expiresAt: expiresAt.toISOString(),
        remaining
      });
      return {
        ...release,
        files,
        grantId,
        expiresAt: expiresAt.toISOString(),
        remaining
      };
    } catch (error) {
      logger.error("Signed firmware URLs could not be created", error);
      throw new HttpsError(
        "internal",
        "Secure firmware access could not be prepared. Contact the operator."
      );
    }
  }
);

export const recordFirmwareInstall = onCall(
  {
    region: REGION,
    cors: ["https://admepls.github.io", /^http:\/\/localhost(?::\d+)?$/],
    memory: "256MiB",
    timeoutSeconds: 30,
    minInstances: 0,
    maxInstances: 2,
    concurrency: 10,
    invoker: "public",
    enforceAppCheck: false
  },
  async (request) => {
    const installer = requireApprovedInstaller(request);
    const data = request.data && typeof request.data === "object"
      ? request.data
      : {};
    const grantId = requireReportField(
      data.grantId,
      "grantId",
      /^\d{8}-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    const attemptId = requireReportField(
      data.attemptId,
      "attemptId",
      /^[a-z0-9-]{12,80}$/i
    );
    const operation = requireReportField(
      data.operation,
      "operation",
      /^(full-install|firmware-update)$/
    );
    const grantDayKey = grantId.slice(0, 8);
    const nowMs = Date.now();
    const { dayKey: successDayKey } = utcWindowKeys(new Date(nowMs));
    let decision = null;

    const transaction = await getDatabase()
      .ref(INSTALL_METRICS_PATH)
      .transaction(
        (current) => {
          decision = applySuccessfulInstall(current, {
            grantDayKey,
            successDayKey,
            grantId,
            uidKey: installerUidKey(installer.uid),
            attemptId,
            operation,
            nowMs,
            maxSuccessesPerGrant: MAX_SUCCESSES_PER_GRANT
          });
          return decision.accepted ? decision.state : undefined;
        },
        undefined,
        false
      );

    if (!decision?.accepted) {
      const reason = decision?.reason || "transaction-aborted";
      if (reason === "grant-owner-mismatch") {
        throw new HttpsError(
          "permission-denied",
          "This installation grant belongs to another account."
        );
      }
      if (reason === "grant-limit") {
        throw new HttpsError(
          "resource-exhausted",
          "This installation grant has reached its reporting limit."
        );
      }
      throw new HttpsError(
        "failed-precondition",
        "This installation grant is missing or expired."
      );
    }
    if (!transaction.committed) {
      throw new HttpsError(
        "aborted",
        "The successful installation could not be recorded. Try again."
      );
    }

    logger.info("Successful firmware operation recorded", {
      uid: installer.uid,
      email: installer.email,
      grantId,
      attemptId,
      operation,
      duplicate: Boolean(decision.duplicate),
      counts: decision.counts
    });
    return {
      status: true,
      duplicate: Boolean(decision.duplicate),
      counts: decision.counts
    };
  }
);
