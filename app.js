import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-functions.js";
import {
  ReCaptchaEnterpriseProvider,
  initializeAppCheck
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app-check.js";
import { DMI_HS_UPDATER_CONFIG as config } from "./config.js";

const browserNotice = document.getElementById("browser-notice");
const releaseError = document.getElementById("release-error");
const releaseVersion = document.getElementById("release-version");
const releasePublished = document.getElementById("release-published");
const releaseState = document.getElementById("release-state");
const operations = document.getElementById("operations");
const fullInstaller = document.getElementById("full-install-button");
const updateInstaller = document.getElementById("firmware-update-button");
const fullAction = fullInstaller?.querySelector('[slot="activate"]');
const updateAction = updateInstaller?.querySelector('[slot="activate"]');
const updateConfirm = document.getElementById("update-confirm");
const signedOutControls = document.getElementById("signed-out-controls");
const signedInControls = document.getElementById("signed-in-controls");
const signInButton = document.getElementById("sign-in-button");
const signOutButton = document.getElementById("sign-out-button");
const prepareButton = document.getElementById("prepare-button");
const identityMark = document.getElementById("identity-mark");
const identityName = document.getElementById("identity-name");
const identityEmail = document.getElementById("identity-email");
const accessStatus = document.getElementById("access-status");

let currentUser = null;
let releaseIsReady = false;
let accessExpiresAt = 0;
let prepareRetryAt = 0;
let authBusy = false;
const generatedManifestUrls = [];

const firebaseApp = initializeApp(config.firebase);
if (typeof config.appCheckSiteKey === "string" && config.appCheckSiteKey.trim()) {
  initializeAppCheck(firebaseApp, {
    provider: new ReCaptchaEnterpriseProvider(config.appCheckSiteKey.trim()),
    isTokenAutoRefreshEnabled: true
  });
}
const auth = getAuth(firebaseApp);
const functions = getFunctions(firebaseApp, config.functionsRegion);
const getProtectedRelease = httpsCallable(functions, "getFirmwareRelease", {
  timeout: 30000
});

function showBrowserWarning() {
  if (!browserNotice) return;
  const serialUnavailable = !("serial" in navigator);
  browserNotice.hidden = window.isSecureContext && !serialUnavailable;
}

function setAccessStatus(message, kind = "neutral") {
  if (!accessStatus) return;
  accessStatus.textContent = message;
  accessStatus.dataset.kind = kind;
}

function hideReleaseError() {
  if (releaseError) releaseError.hidden = true;
}

function showReleaseError(message) {
  if (!releaseError) return;
  releaseError.textContent = message;
  releaseError.hidden = false;
}

function requireSignedStorageUrl(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(fieldName + " is missing.");
  }
  const parsed = new URL(value);
  const signedStorageHost =
    parsed.hostname === "storage.googleapis.com" ||
    parsed.hostname.endsWith(".storage.googleapis.com");
  if (parsed.protocol !== "https:" || !signedStorageHost) {
    throw new Error(fieldName + " is not a protected Storage URL.");
  }
  return parsed.href;
}

function validateRelease(value) {
  if (!value || typeof value !== "object") {
    throw new Error("The protected release response is invalid.");
  }
  if (typeof value.version !== "string" || value.version.trim() === "") {
    throw new Error("The protected release has no version.");
  }
  if (!value.files || typeof value.files !== "object") {
    throw new Error("The protected release has no file list.");
  }
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("The protected release expired before it could be prepared.");
  }

  return {
    version: value.version.trim(),
    published:
      typeof value.published === "string" && value.published.trim()
        ? value.published.trim()
        : "Not specified",
    expiresAt,
    remaining: value.remaining || {},
    files: {
      bootloader: requireSignedStorageUrl(value.files.bootloader, "bootloader"),
      partitions: requireSignedStorageUrl(value.files.partitions, "partitions"),
      firmware: requireSignedStorageUrl(value.files.firmware, "firmware")
    }
  };
}

function createInstallerManifest(release, parts) {
  const manifest = {
    name: "DMI-HS",
    version: release.version,
    new_install_prompt_erase: true,
    new_install_improv_wait_time: 0,
    builds: [
      {
        chipFamily: "ESP32",
        improv: false,
        parts
      }
    ]
  };
  const blob = new Blob([JSON.stringify(manifest)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  generatedManifestUrls.push(url);
  return url;
}

function clearInstallerManifests() {
  generatedManifestUrls.splice(0).forEach((url) => URL.revokeObjectURL(url));
  if (fullInstaller) fullInstaller.manifest = "";
  if (updateInstaller) updateInstaller.manifest = "";
  fullInstaller?.removeAttribute("manifest");
  updateInstaller?.removeAttribute("manifest");
}

function syncFlashActions() {
  if (fullAction) fullAction.disabled = !releaseIsReady;
  if (updateConfirm) updateConfirm.disabled = !releaseIsReady;
  if (updateAction) {
    updateAction.disabled = !(releaseIsReady && updateConfirm?.checked);
  }
}

function lockRelease(message, stateText = "Access locked") {
  releaseIsReady = false;
  accessExpiresAt = 0;
  // ESP Web Tools can read its manifest again while completing/closing a
  // successful installation. Keep the local blob URLs alive until a new
  // release replaces them or this page unloads. The flash actions are disabled
  // below, and the Storage URLs inside the manifest still expire server-side.
  operations?.classList.add("operations-locked");
  if (releaseState) {
    releaseState.textContent = stateText;
    releaseState.classList.remove("ready", "failed");
  }
  syncFlashActions();
  if (message) setAccessStatus(message);
}

function formatWait(totalSeconds) {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  if (seconds < 60) return seconds + "s";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return minutes + "m";
  return Math.ceil(minutes / 60) + "h";
}

function refreshAccessClock() {
  const now = Date.now();
  if (releaseIsReady && accessExpiresAt <= now) {
    lockRelease("Secure access expired. Prepare the installer again.", "Access expired");
  }

  if (releaseIsReady && releaseState) {
    const remaining = Math.max(0, Math.ceil((accessExpiresAt - now) / 1000));
    releaseState.textContent = "Ready | expires in " + formatWait(remaining);
  }

  if (!prepareButton || !currentUser || authBusy || releaseIsReady) return;
  if (prepareRetryAt > now) {
    const remaining = Math.ceil((prepareRetryAt - now) / 1000);
    prepareButton.disabled = true;
    prepareButton.textContent = "Try again in " + formatWait(remaining);
  } else {
    prepareRetryAt = 0;
    prepareButton.disabled = false;
    prepareButton.textContent = "Prepare secure installer";
  }
}

function setAuthBusy(busy) {
  authBusy = busy;
  if (signInButton) signInButton.disabled = busy;
  if (signOutButton) signOutButton.disabled = busy;
  refreshAccessClock();
}

function describeFirebaseError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (code === "auth/popup-closed-by-user") return "Sign-in was cancelled.";
  if (code === "auth/popup-blocked") return "Allow the Google sign-in popup and try again.";
  if (code === "auth/unauthorized-domain") {
    return "This GitHub Pages domain is not authorized in Firebase Authentication.";
  }
  if (code === "functions/unauthenticated") return "Your sign-in expired. Sign in again.";
  if (code === "functions/permission-denied") {
    return "This Google account is not approved for firmware access.";
  }
  if (code === "functions/resource-exhausted") {
    const retryAfter = Number(error?.details?.retryAfterSeconds) || 3600;
    prepareRetryAt = Date.now() + retryAfter * 1000;
    return "The installer request limit was reached. Try again in " +
      formatWait(retryAfter) + ".";
  }
  if (code === "functions/failed-precondition") {
    return typeof error.message === "string" ? error.message : "Secure access is not ready.";
  }
  return "Secure firmware access could not be prepared. Try again later.";
}

async function signIn() {
  hideReleaseError();
  setAuthBusy(true);
  setAccessStatus("Opening Google sign-in...");
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await signInWithPopup(auth, provider);
  } catch (error) {
    const message = describeFirebaseError(error);
    setAccessStatus(message, "error");
    showReleaseError(message);
  } finally {
    setAuthBusy(false);
  }
}

async function signOutCurrentUser() {
  setAuthBusy(true);
  try {
    await signOut(auth);
  } finally {
    setAuthBusy(false);
  }
}

async function prepareInstaller() {
  if (!currentUser || authBusy) return;
  hideReleaseError();
  setAuthBusy(true);
  if (prepareButton) {
    prepareButton.disabled = true;
    prepareButton.textContent = "Preparing protected files...";
  }
  if (releaseState) releaseState.textContent = "Checking access";
  setAccessStatus("Verifying account and request quota...");

  try {
    const response = await getProtectedRelease({});
    const release = validateRelease(response.data);
    await customElements.whenDefined("esp-web-install-button");
    clearInstallerManifests();

    const fullManifestUrl = createInstallerManifest(release, [
      { path: release.files.bootloader, offset: 0x1000 },
      { path: release.files.partitions, offset: 0x8000 },
      { path: release.files.firmware, offset: 0x20000 }
    ]);
    const updateManifestUrl = createInstallerManifest(release, [
      { path: release.files.firmware, offset: 0x20000 }
    ]);

    if (fullInstaller) fullInstaller.manifest = fullManifestUrl;
    if (updateInstaller) updateInstaller.manifest = updateManifestUrl;
    releaseIsReady = true;
    accessExpiresAt = release.expiresAt;
    operations?.classList.remove("operations-locked");
    if (releaseVersion) releaseVersion.textContent = release.version;
    if (releasePublished) releasePublished.textContent = release.published;
    if (releaseState) releaseState.classList.add("ready");
    const hourRemaining = Number(release.remaining.userHour);
    const quotaText = Number.isFinite(hourRemaining)
      ? " " + hourRemaining + " preparation(s) remain this hour."
      : "";
    setAccessStatus("Secure firmware access is ready." + quotaText, "ready");
    if (prepareButton) {
      prepareButton.disabled = true;
      prepareButton.textContent = "Installer ready";
    }
    syncFlashActions();
    refreshAccessClock();
  } catch (error) {
    lockRelease("", "Access denied");
    const message = describeFirebaseError(error);
    setAccessStatus(message, "error");
    showReleaseError(message);
  } finally {
    setAuthBusy(false);
  }
}

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  hideReleaseError();
  lockRelease("");
  prepareRetryAt = 0;

  if (user) {
    if (signedOutControls) signedOutControls.hidden = true;
    if (signedInControls) signedInControls.hidden = false;
    const name = user.displayName || "Signed-in account";
    if (identityName) identityName.textContent = name;
    if (identityEmail) identityEmail.textContent = user.email || "Verified Firebase user";
    if (identityMark) identityMark.textContent = name.trim().charAt(0).toUpperCase() || "A";
    if (releaseState) releaseState.textContent = "Access locked";
    setAccessStatus("Signed in. Prepare the installer when the ESP32 is connected.");
  } else {
    if (signedOutControls) signedOutControls.hidden = false;
    if (signedInControls) signedInControls.hidden = true;
    if (releaseVersion) releaseVersion.textContent = "Protected";
    if (releasePublished) releasePublished.textContent = "—";
    if (releaseState) releaseState.textContent = "Sign in required";
    setAccessStatus("Authentication is required before flashing.");
  }
  setAuthBusy(false);
  refreshAccessClock();
});

signInButton?.addEventListener("click", signIn);
signOutButton?.addEventListener("click", signOutCurrentUser);
prepareButton?.addEventListener("click", prepareInstaller);
updateConfirm?.addEventListener("change", syncFlashActions);
window.addEventListener("beforeunload", clearInstallerManifests);

showBrowserWarning();
syncFlashActions();
setInterval(refreshAccessClock, 1000);
