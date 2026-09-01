(function () {
  "use strict";

  const config = window.DMI_HS_UPDATER_CONFIG || {};
  const browserNotice = document.getElementById("browser-notice");
  const releaseError = document.getElementById("release-error");
  const releaseVersion = document.getElementById("release-version");
  const releasePublished = document.getElementById("release-published");
  const releaseState = document.getElementById("release-state");
  const releaseSource = document.getElementById("release-source");
  const fullInstaller = document.getElementById("full-install-button");
  const updateInstaller = document.getElementById("firmware-update-button");
  const fullAction = fullInstaller
    ? fullInstaller.querySelector('[slot="activate"]')
    : null;
  const updateAction = updateInstaller
    ? updateInstaller.querySelector('[slot="activate"]')
    : null;
  const updateConfirm = document.getElementById("update-confirm");

  let releaseIsReady = false;
  const generatedManifestUrls = [];

  function showBrowserWarning() {
    if (!browserNotice) return;
    const serialUnavailable = !("serial" in navigator);
    browserNotice.hidden = window.isSecureContext && !serialUnavailable;
  }

  function setReleaseFailure(message) {
    if (releaseVersion) releaseVersion.textContent = "Unavailable";
    if (releaseState) {
      releaseState.textContent = "Release unavailable";
      releaseState.classList.remove("ready");
      releaseState.classList.add("failed");
    }
    if (releaseError) {
      releaseError.textContent =
        "The DMI-HS release could not be loaded. " + message;
      releaseError.hidden = false;
    }
  }

  function requireHttpsUrl(value, fieldName) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(fieldName + " is missing.");
    }

    let parsed;
    try {
      parsed = new URL(value);
    } catch (_error) {
      throw new Error(fieldName + " is not a valid URL.");
    }

    if (parsed.protocol !== "https:") {
      throw new Error(fieldName + " must use HTTPS.");
    }
    return parsed.href;
  }

  function validateRelease(value) {
    if (!value || typeof value !== "object") {
      throw new Error("Firebase returned invalid release information.");
    }
    if (typeof value.version !== "string" || value.version.trim() === "") {
      throw new Error("The release version is missing.");
    }
    if (!value.files || typeof value.files !== "object") {
      throw new Error("The release file list is missing.");
    }

    return {
      version: value.version.trim(),
      published:
        typeof value.published === "string" && value.published.trim() !== ""
          ? value.published.trim()
          : "Not specified",
      files: {
        bootloader: requireHttpsUrl(
          value.files.bootloader,
          "files.bootloader"
        ),
        partitions: requireHttpsUrl(
          value.files.partitions,
          "files.partitions"
        ),
        firmware: requireHttpsUrl(value.files.firmware, "files.firmware")
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
          parts: parts
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

  function syncUpdateAction() {
    if (!updateAction) return;
    updateAction.disabled = !(
      releaseIsReady &&
      updateConfirm &&
      updateConfirm.checked
    );
  }

  async function loadRelease() {
    const releaseUrl = requireHttpsUrl(config.releaseUrl, "config.releaseUrl");
    if (releaseSource) {
      releaseSource.href = releaseUrl;
    }

    const response = await fetch(releaseUrl, {
      cache: "no-store",
      credentials: "omit"
    });
    if (!response.ok) {
      throw new Error(
        "Firebase returned HTTP " +
          response.status +
          ". Check the release URL and CORS headers."
      );
    }

    const release = validateRelease(await response.json());
    await customElements.whenDefined("esp-web-install-button");

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
    if (fullAction) fullAction.disabled = false;

    releaseIsReady = true;
    syncUpdateAction();

    if (releaseVersion) releaseVersion.textContent = release.version;
    if (releasePublished) releasePublished.textContent = release.published;
    if (releaseState) {
      releaseState.textContent = "Ready to flash";
      releaseState.classList.remove("failed");
      releaseState.classList.add("ready");
    }
  }

  showBrowserWarning();
  if (updateConfirm) {
    updateConfirm.addEventListener("change", syncUpdateAction);
  }

  loadRelease().catch(function (error) {
    const detail =
      error instanceof Error ? error.message : "Check Firebase and try again.";
    setReleaseFailure(detail);
  });

  window.addEventListener("beforeunload", function () {
    generatedManifestUrls.forEach(function (url) {
      URL.revokeObjectURL(url);
    });
  });
})();
