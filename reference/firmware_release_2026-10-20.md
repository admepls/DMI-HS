# Standard firmware release preparation — 2026.10.20

Historical preparation record: superseded by the official
[1.0.1 release](firmware_release_1.0.1.md), which also disables per-vendo time
protection monitoring by default. The dated local build folder is retained as
an earlier snapshot; do not substitute it for the rebuilt 1.0.1 files.

Both manifests now identify their target and carry version `2026.10.20`,
published date `2026-10-20`. They are prepared locally, **not uploaded**.
The website/backend hardware-selection changes are also not deployed by this task.

## Prepared upload sets

Local release root: `E:\firmware-releases\Dmi-HS\2026.10.20`.

| Local directory | PlatformIO environment | Private Storage destination |
| --- | --- | --- |
| `esp32\` | `HS` | Bucket root, NOT an `esp32/` prefix |
| `n16r8\` | `n16r8` | `n16r8/` |

Each contains exactly `bootloader.bin`, `partitions.bin`, `firmware.bin`,
and `release.json`. Upload to `gs://dmi-hs.firebasestorage.app` without making
objects public. The release root also includes `checksums.csv` and the
unchanged source partition CSVs; those are for verification, not flashing.

| Hardware | Bootloader | Partitions | Application | Verified image header |
| --- | --- | --- | --- | --- |
| Classic ESP32 / 4 MB | `0x1000` | `0x8000` | `0x20000` | ESP32, DIO, 40 MHz, 4 MB |
| ESP32-S3 N16R8 | `0x0000` | `0x8000` | `0x20000` | ESP32-S3, DIO, 80 MHz, 16 MB |

The shared target catalog already has these offsets; no offset change was
needed. N16R8's custom `N16R8.csv` was preserved, including its `0x658000`
factory app and `0x6AE000` SPIFFS partition. Both partition binaries exactly
match regeneration from their respective CSVs and fit their flash.
App/bootloader checksums and hashes are valid; images fit their regions.

Both firmware builds succeeded with native W5500 support linked. N16R8 retains
octal PSRAM, the PSRAM TLS allocator, and UART0 logs. Ethernet still requires
explicit runtime selection and confirmed S3 wiring, including INT; no physical
hardware test has been performed.

The firmware image's embedded app version is `a0916cc-dirty` (existing working
tree including the user's uncommitted changes). `2026.10.20` is this release's
installer label. Build output and matching ELF files:
`E:\pio-builds\Dmi-HS\20261020-w5500\HS` and `...\n16r8`.
Only the standard non-secure environments were built.

## Upload checklist

1. Back up device records. A new partition table does not relocate existing
   NVS/SPIFFS data, and full erase deletes it. Do not flash these files to
   secure-boot/flash-encrypted boards or a different S3 memory variant.
2. Pause installations; let active grants expire and existing installs finish.
   These are fixed object names, not an atomic versioned-bundle switch.
3. Upload each target's **three matching binaries** to the destination above.
   Do not mix targets/builds, upload `.elf`, or substitute signed/encrypted files.
4. Upload each matching `release.json` **last**. Compare sizes/SHA-256 with the
   local `checksums.csv`.
5. Deploy the target-aware `functions:firmware-access` backend and publish the
   corresponding Pages assets if not already done. Populating metadata alone
   does not deploy hardware-selection support.
6. Bench-test both hardware selections on spare boards before general use.
   Confirm S3 memory, boot, W5500 link/DHCP, RouterOS access and recovery.

Updater verification: **49 tests passed**, including populated target-specific
manifests and rejection of unpublished empty metadata; JavaScript syntax checks
passed. Firmware/source details are documented in
`Dmi-HS/reference/n16r8_w5500_build_2026-10-20.md`.
