# Official firmware release 1.0.1

Publication date in metadata: 2026-10-20.
Both target manifests use `1.0.1`, matching the firmware startup banner and
the ESP-IDF application descriptor (`Dmi-HS/version.txt`).

## Private backup location

Use the user-created directory in the private `admepls/hotspot` repository:

```text
Dmi-HS/firmware/1.0.1/
  N16R8/    # PlatformIO n16r8, ESP32-S3, 16 MB flash / 8 MB PSRAM
  WROOM/    # PlatformIO HS, classic ESP32, 4 MB flash
```

Each hardware directory holds its own `bootloader.bin`, `partitions.bin`,
`firmware.bin` and `release.json`. The archive also includes checksums,
partition CSVs and release notes. These binaries must NOT be committed to
`central_updater2`, the public `admepls/DMI-HS` repository or GitHub Pages.

Published private backup:
[Dmi-HS v1.0.1](https://github.com/admepls/hotspot/releases/tag/v1.0.1).
The tag points to binary-backup commit `f39bf24` on
`firmware-backup/v1.0.1`; the original working branch and unrelated edits
remain untouched. The release contains `DMI-HS-1.0.1-firmware-backup.zip`
and `checksums.csv`. Both assets were downloaded after upload and their
SHA-256 checksums verified. ZIP SHA-256:
`5692ca751c32edfffde00a684f89002f2cf3f47fc6f6c21267917899a15d845f`.

## Protected updater uploads

| Backup directory | Private Firebase Storage destination |
| --- | --- |
| `WROOM/` | Bucket root (no `WROOM/` or `esp32/` prefix) |
| `N16R8/` | `n16r8/` (lowercase) |

Pause installations and let active grants/installs finish before replacing
fixed filenames. Upload all three matching binaries before `release.json`.
Never mix boards or versions. Existing installer offsets are unchanged:
classic bootloader `0x1000`, S3 bootloader `0x0000`, both partition tables
`0x8000` and applications `0x20000`.

N16R8 retains the user's custom `N16R8.csv` layout; WROOM retains
`huge_app.csv`. Back up device records first: partition-table changes do not
migrate existing NVS/SPIFFS data. Full erase deletes it.

## Default behavior

**Monitor time protection from this vendo** defaults to OFF for fresh/reset
configuration or when the `cpMonitor` preference is absent. An explicitly saved
ON or OFF remains unchanged. This does not disable router-side checkpoint
capture/recovery, schedules or transaction-readiness safety checks.

Both standard/non-secure builds retain W5500 support. N16R8 needs confirmed
SPI/INT wiring and an independent recovery input; compilation is not physical
hardware qualification. Do not install these images on secure-boot or
flash-encrypted boards.

Build output: `E:\pio-builds\Dmi-HS\v1.0.1`.
The private binary archive records the built working-tree provenance; its tag
does not claim that every pre-existing local source edit was published.
Publishing the private backup does not deploy the updater backend, Pages,
Firebase firmware objects or devices.
