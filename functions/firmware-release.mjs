import { getFirmwareTarget } from "./firmware-targets.mjs";

export function requireFirmwareTarget(id) {
  // Only old clients that omit the field retain the classic ESP32 default.
  // Invalid/unknown explicit targets must never fall back to another board.
  const target = getFirmwareTarget(id === undefined ? "esp32" : id);
  if (!target) throw new Error("Select a supported hardware target.");
  return target;
}

export function validateReleaseMetadata(value, target) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("release.json is not an object");
  }
  if (typeof value.version !== "string" || value.version.trim() === "") {
    throw new Error("release.json has no version");
  }
  const legacyClassic = target.id === "esp32" && value.target === undefined;
  if (!legacyClassic && value.target !== target.id) {
    throw new Error("release.json does not match the selected hardware");
  }
  return {
    target: target.id,
    chipFamily: target.chipFamily,
    version: value.version.trim(),
    published:
      typeof value.published === "string" && value.published.trim() !== ""
        ? value.published.trim()
        : "Not specified"
  };
}

export async function readTargetRelease(bucket, target) {
  const [contents] = await bucket.file(target.releaseObject).download();
  const release = validateReleaseMetadata(JSON.parse(contents.toString("utf8")), target);
  // Signing a URL does not check whether the object exists. Fail preparation
  // clearly if this hardware's artifacts have not been uploaded yet.
  const available = await Promise.all(
    Object.values(target.files).map(async (name) => {
      const [exists] = await bucket.file(name).exists();
      return exists;
    })
  );
  if (available.some((exists) => !exists)) {
    throw new Error("The selected hardware release is missing firmware files");
  }
  return release;
}

export async function createSignedFiles(bucket, target, expiresAt) {
  const entries = await Promise.all(
    Object.entries(target.files).map(async ([key, objectName]) => {
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
