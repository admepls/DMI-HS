import { createHash } from "node:crypto";
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

initializeApp();
const cloudStorage = new Storage();

const REGION = "asia-southeast1";
const BUCKET_NAME = "dmi-hs.firebasestorage.app";
const RELEASE_OBJECT = "release.json";
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
  const uidKey = createHash("sha256").update(uid).digest("hex").slice(0, 32);
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
