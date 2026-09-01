# DMI-HS ESP32 Installer

A small GitHub Pages site for installing and updating the standard,
non-encrypted DMI-HS ESP32 firmware. ESP Web Tools handles the USB connection in
desktop Chrome or Edge.

The GitHub repository contains only the website. Firebase serves the release
information and firmware binaries.

## What the two buttons do

### Full installation

Use this for a clean or replacement ESP32. Choose erase when prompted.

| File | Offset |
| --- | --- |
| `bootloader.bin` | `0x1000` |
| `partitions.bin` | `0x8000` |
| `firmware.bin` | `0x20000` |

### Firmware update

Use this only on a working standard DMI-HS installation. It writes
`firmware.bin` at `0x20000`.

Leave **Erase device** turned off in ESP Web Tools. Erasing during a
firmware-only update would remove the bootloader, partition table, settings, and
local data. If an erase is required, cancel and use Full installation.

## Firebase release layout

Publish each release into its own versioned directory:

```text
/firmware/
  release.json
  2026.09.01/
    bootloader.bin
    partitions.bin
    firmware.bin
```

The three binaries must come from the same DMI-HS `HS` build:

```powershell
pio run -e HS
```

Copy these files from `.pio/build/HS`:

- `bootloader.bin`
- `partitions.bin`
- `firmware.bin`

Do not publish signed or encrypted firmware through this standard installer.

## Create release.json

Use [manifests/release.example.json](manifests/release.example.json) as the
template. Every file URL must be an absolute public HTTPS URL.

```json
{
  "version": "2026.09.01",
  "published": "2026-09-01",
  "files": {
    "bootloader": "https://dmi-hs.web.app/firmware/2026.09.01/bootloader.bin",
    "partitions": "https://dmi-hs.web.app/firmware/2026.09.01/partitions.bin",
    "firmware": "https://dmi-hs.web.app/firmware/2026.09.01/firmware.bin"
  }
}
```

Upload the three binaries first. Open each URL in a private browser window and
confirm it downloads successfully. Upload `release.json` last so the public
installer never advertises an incomplete release.

## Point the website at Firebase

[config.js](config.js) contains one setting:

```javascript
window.DMI_HS_UPDATER_CONFIG = Object.freeze({
  releaseUrl: "https://dmi-hs.web.app/firmware/release.json"
});
```

Change the URL if a different Firebase Hosting domain or Firebase Storage URL
is used.

## CORS requirement

The GitHub Pages origin must be allowed to fetch both `release.json` and all
three binaries.

For this repository owner, the GitHub Pages origin is normally:

```text
https://admepls.github.io
```

When Firebase Hosting serves the files, configure a header for
`/firmware/**` similar to:

```json
{
  "source": "/firmware/**",
  "headers": [
    {
      "key": "Access-Control-Allow-Origin",
      "value": "https://admepls.github.io"
    }
  ]
}
```

If Firebase Storage serves the files, apply the equivalent bucket CORS rule.
The release and binary URLs must remain public because ESP Web Tools cannot
attach Firebase Authentication credentials.

## Publish the website with GitHub Pages

1. Push `index.html`, `styles.css`, `config.js`, `app.js`, and `assets`
   to GitHub.
2. In the repository settings, enable GitHub Pages for the main branch and root
   directory.
3. Open the generated HTTPS page in desktop Chrome or Edge.
4. Confirm the release card says **Ready to flash**.
5. Test Full installation on a spare clean ESP32.
6. Test Firmware update on a configured DMI-HS controller and confirm its
   settings remain.

GitHub Pages is HTTPS, which is required by Web Serial.

## Test locally

```powershell
cd C:\Users\Demi\Documents\PlatformIO\central_updater2
python -m http.server 8000
```

Open `http://localhost:8000` in desktop Chrome or Edge. Browsers treat
`localhost` as a secure context for Web Serial.

The Firebase release still needs valid CORS headers permitting
`http://localhost:8000` during local testing. Remove that development origin
from CORS when it is no longer needed.

## Important limits

- This installer does not enable or disable security eFuses.
- Do not use it on an ESP32 that already has Secure Boot or Flash Encryption
  enabled.
- The firmware update must use the same partition layout as the installed
  controller.
- Close PlatformIO and serial monitors before connecting through the browser.
