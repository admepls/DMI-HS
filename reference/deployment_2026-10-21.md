# Updater deployment — 2026-10-21

## Scope and safeguards

User authorized deployment after uploading both hardware targets, then supplied
a replacement portal-assets URL:
https://drive.google.com/file/d/1Cmf5eVVq14_sZ7eevV1roYvO_HcTo3D0/view?usp=sharing

- Deploy only Firebase codebase `firmware-access` in `dmi-hs`.
- Publish the N16R8/classic hardware selector and the new portal-assets link.
- Preserve the existing installer account allowlist, grant quotas, signed-URL
  lifetime and App Check setting.
- Do not deploy Storage rules, Premium functions or device-management functions.
- Do not rebuild, flash or replace firmware, or publish binaries in this repo.
- Use an isolated deployment worktree so unrelated local changes remain intact.

## Preflight

The eight Storage objects match the current local `firmware/1.0.1` files.
Metadata labels both targets `1.0.1`. The current uploaded files differ from
the binaries recorded during the earlier private-backup publication:

| Target | Current firmware bytes | SHA-256 | Embedded app version |
| --- | ---: | --- | --- |
| WROOM | 2,217,360 | `d410e9f6e385b196d0c582067816c72508a60d77228ea6592e6286866c508e6f` | `a0916cc-dirty` |
| N16R8 | 2,232,608 | `fa2ad32ac4128d38073e7a6ee7e88c1d6d8d38bc3d6a523a7fa5881e22ac551c` | `1.0.1` |

Both application images have valid checksums/hashes and correct ESP32/ESP32-S3
chip IDs and flash headers. WROOM's internal version mismatch was reported to
the user; its uploaded contents are deliberately left unchanged. Correct that
build label before treating it as the finalized v1.0.1 binary release.

The user separately approved removal of Firebase download tokens from all eight
objects. All eight tokens were removed; every old token link returned HTTP 403.
Object generations, content hashes, sizes and unrelated metadata were preserved.
Bucket CORS already permits GET/HEAD from `https://admepls.github.io`.

Deployment evidence and sanitized pre-deploy function revisions are stored
locally at `E:\AI-Tools\Generated\central_updater2\deploy-20261021`.

## Rollout and rollback

Deploy the backend first; the old browser remains compatible with the classic
target. Publish the website only after the backend is healthy. GitHub Pages
should use the existing Actions workflow, not the legacy branch-root publisher,
so only the explicitly staged public files are served.

Previous website commit: `98b4ffdd1fcb01f8dc45320e89df474de8983728`.
Previous function revisions:

- `getfirmwarerelease-00003-loz`
- `recordfirmwareinstall-00002-voq`

For a rollback, return the website to the previous public artifact and the
updater services to the recorded prior revisions. Do not restore revoked
download tokens or change firmware objects, Storage rules or other services.
Physical flashing and approved-user sign-in remain separate operator tests.
