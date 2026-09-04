# DMI-HS protected ESP32 installer

GitHub Pages installer for standard, non-encrypted DMI-HS ESP32 firmware:

```text
https://admepls.github.io/DMI-HS/
```

The page requires Firebase Google sign-in. An approved user must explicitly
prepare the installer before either flash button is enabled. A callable backend
checks the account and rate limits, then issues short-lived Cloud Storage URLs.

## Protection model

```text
Google sign-in
  -> approved email or firmwareInstaller custom claim
  -> atomic hourly/daily/global rate-limit transaction
  -> three-minute signed firmware URLs
  -> ESP Web Tools flash buttons enabled
```

Storage Security Rules deny every client read and write. The backend reads the
private files through its service account. Rate-limit counters are stored under
`firmwareInstallerRateLimits` in the existing locked Realtime Database and old
counter windows are removed automatically.

Default limits:

| Limit | Default |
| --- | ---: |
| Per approved user, per UTC hour | 3 |
| Per approved user, per UTC day | 10 |
| All approved users, per UTC day | 30 |
| Signed URL lifetime | 180 seconds |
| Function instances | 2 maximum |

These limits control release grants. A signed URL can still be reused until it
expires, so the short lifetime is an important part of the usage protection.

## Firebase Storage files

Keep these private files at the root of `gs://dmi-hs.firebasestorage.app`:

```text
bootloader.bin
partitions.bin
firmware.bin
release.json
```

The three binaries must come from the same standard DMI-HS build:

```powershell
pio run -e HS
```

Copy the binaries from `.pio/build/HS`. Do not publish signed or encrypted
firmware through this installer.

Update [manifests/release.json](manifests/release.json), then upload it to the
Storage root after the three binaries. It contains only the display version and
date; the backend never trusts file URLs from this JSON.

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

## 4. Deploy the private rule and function

Cloud Functions deployment requires a Firebase project with billing enabled.
From the repository root:

```powershell
npx -y firebase-tools@latest deploy --only storage,functions --project dmi-hs
```

If signed URL creation reports `iam.serviceAccounts.signBlob` permission denied,
grant the function runtime service account both:

- **Service Account Token Creator** on that service account.
- **Storage Object Viewer** on `dmi-hs.firebasestorage.app`.

Do not grant public Storage access. [storage.rules](storage.rules) intentionally
denies every client operation.

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

Commit and push the website and functions source. After GitHub Pages refreshes:

1. Open the installer in desktop Chrome or Edge.
2. Confirm both flash buttons are disabled.
3. Sign in with an approved Google account.
4. Click **Prepare secure installer**.
5. Confirm the release card shows a short expiration countdown.
6. Test full installation on a spare ESP32.
7. Test firmware update without erasing a configured controller.

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
