# DMI-HS protected ESP32 installer

GitHub Pages installer for standard, non-encrypted DMI-HS firmware on:

- **ESP32-S3 N16R8 — recommended:** 16 MB flash and 8 MB octal PSRAM.
- **Classic ESP32:** existing 4 MB flash hardware remains supported.

N16R8 provides more flash storage and PSRAM headroom; it is not a promise of a
particular traffic capacity. Confirm the module marking: an arbitrary ESP32-S3
with less flash/PSRAM is not interchangeable with N16R8.

```text
https://admepls.github.io/DMI-HS/
```

The page requires Firebase Google sign-in. An approved user must explicitly
select the actual hardware and prepare the installer before the full-install
button is enabled. A callable
backend checks the requesting IP, account and rate limits, then issues short-lived Cloud
Storage URLs.

## Protection model

```text
shared per-IP API admission (both callable endpoints)
  -> Google sign-in
  -> approved email or firmwareInstaller custom claim
  -> atomic per-user / per-IP / global firmware-grant transaction
  -> three-minute signed firmware URLs
  -> ESP Web Tools flash buttons enabled
```

The staged Storage Security Rules deny direct client reads and writes, including
`portal-skins/**`. Deploy this rules change only after the app's new Premium
backend and App Check flow are tested; it closes the former public Gallery path.
See `../dmi_hsa/reference/premium_security.md` for the coordinated cutover.
The firmware backend reads the private
firmware through its service account. Rate-limit counters are stored under
`firmwareInstallerRateLimits` in the existing locked Realtime Database and old
counter windows are removed automatically.

Successful full installations are counted separately from installer
preparations. The authenticated backend writes these counters under
`firmwareInstallerInstallMetrics`:

```text
totals/fullInstall
totals/total
daily/YYYYMMDD/...
versions/VERSION/...
```

The page reports a success only after ESP Web Tools finishes writing, resets,
and disconnects from the ESP32. Reports are idempotent, so retrying the same
report cannot increment a counter twice. Temporary grants used to validate a
report are automatically removed; the aggregate counters remain.

Default limits:

| Limit | Default |
| --- | ---: |
| Per approved user, per UTC hour | 3 |
| Per approved user, per UTC day | 10 |
| All approved users, per UTC day | 30 |
| Firmware preparations per public IP, per UTC hour / day | 3 / 10 |
| Combined API requests per public IP, per UTC minute / hour / day | 10 / 60 / 100 |
| Combined API admissions across all IPs, per UTC day | 1,000 |
| Signed URL lifetime | 180 seconds |
| Function instances | 2 maximum |

Firmware-preparation limits control release grants; API-request limits cover
calls as described below. A signed URL can still be reused until it expires,
so the short lifetime is an important part of the usage protection.

### Per-IP protection and billing limits

The API-request limits cover `getFirmwareRelease` and `recordFirmwareInstall`
together, before account approval, release metadata reads, signed URLs or
installation metrics. Requests reaching the handler consume this allowance
even if account approval or validation subsequently rejects them. Firebase's
protocol/token validation, preflights, and platform errors can happen before
the handler; those requests are not counted by this application limiter.
Account approval remains mandatory; a free installer does not mean open access.

Counters use an atomic Realtime Database transaction at
`firmwareInstallerIpRequestLimits/<UTC-day>`. All instances/functions share it.
Keep this path denied to client reads/writes in the existing locked database.
Only daily SHA-256 network identifiers are stored, not raw IP addresses; these
are pseudonymous identifiers, not encryption. Normal IPv6 addresses share a
/64 bucket, and IPv4-mapped IPv6 shares its IPv4 bucket. Users behind one public
IP (home, shop, mobile carrier or VPN) share the allowance. UTC resets are
08:00 in the Philippines/China for daily counters; fixed windows can allow a
burst spanning a window boundary.

Rejected IPs are cached in a bounded per-instance cache until their window
ends, avoiding repeated quota database work. Allowed requests are never cached.
A database outage fails closed. A global 1,000/day admission ceiling bounds the
daily counter's size and further application work, but can also be exhausted
by abusive clients and deny legitimate users until the next UTC day. Rotating
IPs cannot bypass that global ceiling or the existing account quotas.
Old request-counter days are cleaned in bounded batches during an approved
firmware preparation (three-day retention target, not a background TTL).

Rate limits run **inside a billable function invocation**. They are not a
spending cap or a DDoS shield: invocations, authentication/token handling,
logging, denied quota checks and Storage egress can still cost money. In
particular, signed download URLs remain reusable until expiry and downloads
go directly to Storage, not through this IP limiter. For strict per-download
bandwidth control, use a metered download gateway; do not make Storage public.
Set low billing alerts and consider the available
[Firebase service spend caps](https://firebase.google.com/docs/projects/billing/spend-caps).
Those caps have reporting delays/possible overages and do not cover every
service, including these direct Cloud Storage downloads.

Configuration defaults are in `functions/.env.example`. Copy only desired
overrides into the existing ignored `.env.dmi-hs`; do not replace your approved
accounts. Preparation attempts consume a grant before metadata reads, even
if preparation subsequently fails, to bound repeated backend work.
The browser displays a retry countdown. Temporary IP/API limits retain pending
installation reports and stop that flush; they do not undo the successful flash.
Reports retry on a later normal flush after cooldown, not an automatic loop;
the existing report-grant expiration still applies.

#### Trusted IP / deployment checks

This setup calls Google's callable endpoints directly. `IP_TRUSTED_PROXY_HOPS=1`
selects the rightmost platform-appended `X-Forwarded-For` address. It deliberately
does not trust `request.ip` (the framework trusts all proxy hops), the leftmost
header value, `X-Real-IP`, `CF-Connecting-IP`, or callable payload fields.
Missing/malformed IPs fail closed; direct socket fallback is emulator-only.

**Verify the deployed forwarding chain before relying on per-client limits.**
An added load balancer/CDN changes the topology: Google's external Application
Load Balancer appends both a client and load-balancer address. A wrong hop count
can group clients under a proxy IP or trust a spoofed prefix. Do not change
the hop count unless all exposed routes have the same verified trusted suffix;
close alternate origins if moving behind an edge limiter. See
[Google's header documentation](https://docs.cloud.google.com/functions/docs/reference/headers)
and [load-balancer forwarding behavior](https://docs.cloud.google.com/load-balancing/docs/https#x-forwarded-for_header).

Before production acceptance, use a staging project to verify: one IP exceeds
its limit, a second real public IP retains its own allowance, different approved
accounts share the same-IP allowance, and adding fake XFF prefixes never changes
the bucket. Do not test by repeatedly downloading production firmware.

Run `npm test` and `npm run check` under `functions`. Deploy only this codebase
from the installer root:

```powershell
firebase deploy --only functions:firmware-access --project dmi-hs
```

Then publish the updated `app.js` and `index.html` through the normal Pages
workflow. Source changes are not live
until deployed; no firmware or APK rebuild is needed. App Check configuration
is a separate recommended step below and is not enabled by this patch.

## Hardware targets and private Firebase Storage files

The hardware catalog in `functions/firmware-targets.mjs` is shared by the
browser and backend. It contains public board information only. Pages publishes
that **single file**, not the rest of `functions/`. Requests may select only
`esp32` or `n16r8`; the backend chooses fixed object paths, not client-provided URLs.
An old client omitting `target` still selects classic ESP32, never N16R8.

Keep these private files in `gs://dmi-hs.firebasestorage.app`:

```text
bootloader.bin                # Classic ESP32 only
partitions.bin
firmware.bin
release.json
n16r8/
  bootloader.bin              # ESP32-S3 N16R8 only
  partitions.bin
  firmware.bin
  release.json
```

| Selection | PlatformIO environment | Chip family | Bootloader | Partitions | App |
| --- | --- | --- | --- | --- | --- |
| Classic ESP32 / 4 MB | `HS` | `ESP32` | `0x1000` | `0x8000` | `0x20000` |
| ESP32-S3 N16R8 / 16 MB + 8 MB PSRAM | `n16r8` | `ESP32-S3` | `0x0000` | `0x8000` | `0x20000` |

For **each target**, use all three `.bin` files from the same standard DMI-HS
build: `.pio/build/HS` for classic and `.pio/build/n16r8` for N16R8.
Do not mix binaries across targets, use `.elf` files, or publish signed/encrypted
images. N16R8 uses `N16R8.csv` with a factory app at `0x20000` and no OTA slots.
This updater performs USB full installation, not an OTA layout migration.

ESP Web Tools writes binary images as supplied; unlike a normal esptool upload,
it does not patch flash mode/frequency/size on the fly. Before publishing,
verify the bootloader header matches the build's generated flash arguments
(N16R8: DIO header, 80 MHz, 16 MB in the current SDK configuration).
Prepare browser-ready images if necessary, then bench-test the exact published
set. See the [ESP Web Tools firmware preparation guide](https://esphome.github.io/esp-web-tools/#preparing-your-firmware).

Classic metadata stays in [manifests/release.json](manifests/release.json);
upload it to the Storage root after the matching classic binaries.
Existing classic metadata without `target` remains compatible.

Both checked-in manifests are prepared for release **1.0.1**, dated
2026-10-20, and explicitly identify their hardware target. See the
[release preparation record](reference/firmware_release_1.0.1.md) for the
local binary folders, checks and upload mapping. The firmware startup banner
and ESP-IDF application descriptor also use `1.0.1`.
Firmware backups belong only in the private firmware repository, not this
public updater repository or its Pages output.

Keep `"target": "n16r8"` in
[manifests/n16r8/release.json](manifests/n16r8/release.json), and upload it to
`n16r8/release.json` **after** all three N16R8 binaries. Likewise, upload the
classic manifest last, at the Storage root. For later releases, update each
manifest's version/date together with its matching build set. An empty version
still fails closed. Binaries remain outside this website repository.

The backend rejects mismatched metadata and missing files rather than falling
back to another board. It signs only that board's three allowlisted objects.
It does not inspect binary headers or verify PSRAM capacity; the operator is
responsible for correct artifacts and the user for selecting their actual
hardware. ESP Web Tools' chip-family check distinguishes ESP32 from ESP32-S3,
not different S3 flash/PSRAM variants.

Switching hardware discards prepared links and requires another preparation.
Hardware changes and new preparations are blocked while an installer dialog is
open. Quotas remain shared across hardware targets; changing the selection does
not reset allowances. Installation grants record their target; existing global,
daily, and version counters remain unchanged.

### N16R8 rollout checklist

1. Prepare and verify matching, non-secure N16R8 `.bin` artifacts; no firmware
   build or upload is performed by the website change itself.
2. Upload the private `n16r8/` binaries, then completed `n16r8/release.json`.
   Pause new installations during replacement and wait for active grants to
   expire/installs to finish to avoid mixing release files.
3. Deploy only `functions:firmware-access`, then publish the Pages files using
   the existing workflow. No Firebase rules or app deployment is needed for
   this hardware-selection change.
4. Sign in, choose N16R8, prepare, and bench-test a full installation on a spare
   N16R8 board. Confirm startup reports 16 MB flash and about 8 MB PSRAM, then
   verify networking and pins. Prefer USB-to-UART for the current UART0 logs.
5. Repeat the classic ESP32 path and verify that a wrong chip family is refused.
   Back up settings before any full erase; do not test on deployed vendos.

Source verification: `npm test` and `npm run check` in `functions` cover both
hardware paths, manifest offsets, missing releases, selection invalidation,
dialog locking, legacy compatibility, and existing rate limits/install reporting.

## 1. Enable Google sign-in

In Firebase Console for project `dmi-hs`:

1. Open **Authentication > Sign-in method**.
2. Enable **Google** and select a support email.
3. Open **Authentication > Settings > Authorized domains**.
4. Add `admepls.github.io` without `https://` or `/DMI-HS/`.

The web Firebase configuration is already present in [config.js](config.js).
Firebase web API keys are identifiers, not administrator credentials; Storage
and backend authorization still fail closed.

## 2. Set approved accounts and quotas

The local `functions/.env.dmi-hs` is ignored by Git and currently contains the
approved owner account plus the strict default limits. To approve more accounts,
add comma-separated verified Google email addresses:

```dotenv
INSTALLER_EMAILS=owner@example.com,technician@example.com
LIMIT_PER_USER_HOUR=3
LIMIT_PER_USER_DAY=10
LIMIT_GLOBAL_DAY=30
SIGNED_URL_TTL_SECONDS=180
ENFORCE_APP_CHECK=false
```

Alternatively, set the Firebase Auth custom claim `firmwareInstaller: true` on
an approved user. Never place an allowlist check only in browser JavaScript.

## 3. Install and test the backend

```powershell
cd C:\Users\Demi\Documents\PlatformIO\central_updater2\functions
npm install
npm test
npm run check
```

The callable function runs in `asia-southeast1`, matching the existing Realtime
Database. Its maximum instance count is fixed at two.

## 4. Deploy the updater functions

Cloud Functions deployment requires a Firebase project with billing enabled.
From the repository root:

```powershell
firebase deploy --only functions:firmware-access --project dmi-hs
```

Do not deploy Storage rules or the other function codebases as part of an
updater release. The staged Premium/Gallery rule change is a separate,
coordinated app cutover.

If signed URL creation reports `iam.serviceAccounts.signBlob` permission denied,
grant the function runtime service account both:

- **Service Account Token Creator** on that service account.
- **Storage Object Viewer** on `dmi-hs.firebasestorage.app`.

Do not grant bucket-wide public Storage access. [storage.rules](storage.rules)
keeps firmware and skins private. The new app uses the separate `premium-access`
backend, which verifies Auth, App Check and purchases before reading skins.
Do not restore the old public Gallery exception. No client writes are allowed;
upload skins with an
authorized administrator account. Never place firmware or secrets in that folder.

## 5. Apply CORS

[storage-cors.json](storage-cors.json) allows firmware reads from only the
GitHub Pages origin. Apply it through Google Cloud Storage bucket configuration
or Google Cloud CLI:

```powershell
gcloud storage buckets update gs://dmi-hs.firebasestorage.app --cors-file=storage-cors.json
```

The origin is `https://admepls.github.io`; URL paths are not part of a CORS
origin.

## 6. Optional App Check enforcement

Authentication, account approval, and rate limiting work without App Check.
The client and backend hooks are already implemented, but enforcement stays off
until a valid site key exists:

1. In Firebase **App Check**, register the existing web app with a reCAPTCHA
   Enterprise key authorized for `admepls.github.io`.
2. Put the public site key in `appCheckSiteKey` in [config.js](config.js).
3. Set `ENFORCE_APP_CHECK=true` in `functions/.env.dmi-hs`.
4. Redeploy the function.

Do not enable backend enforcement before publishing the configured client or
all release requests will be rejected.

## 7. Publish GitHub Pages

Push the website and functions source to the `main` branch. The included GitHub
Pages workflow publishes only the browser-facing installer files. After the
deployment finishes:

1. Open the installer in desktop Chrome or Edge.
2. Confirm the full-install button is disabled.
3. Sign in with an approved Google account.
4. Select the actual hardware, then click **Prepare protected firmware**.
5. Confirm the release card shows a short expiration countdown.
6. Test full installation on a spare ESP32.
7. Confirm the installer reports completion and the ESP32 restarts normally.

## Usage safeguards and limitations

- Set a Cloud Billing budget and low threshold alerts. Budget alerts are not a
  hard spending cap.
- Keep the allowlist small and remove accounts that no longer need access.
- Keep the signed URL lifetime short.
- The global daily quota stops new URL grants after the configured limit.
- An already-issued signed URL remains usable until expiration. A strict
  per-download byte cap requires a metered download proxy or CDN rather than
  direct Cloud Storage signed URLs.
- This installer does not enable or disable ESP32 security eFuses.
- Do not use it on a board with Secure Boot or Flash Encryption enabled.
