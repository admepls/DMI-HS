// Public hardware catalog, shared by the browser and the callable backend.
// Keep credentials, account lists, and other server-only settings out of here.
export const FIRMWARE_TARGETS = Object.freeze({
  n16r8: Object.freeze({
    id: "n16r8",
    label: "ESP32-S3 N16R8",
    chipFamily: "ESP32-S3",
    memory: "16 MB flash / 8 MB PSRAM",
    recommended: true,
    releaseObject: "n16r8/release.json",
    files: Object.freeze({
      bootloader: "n16r8/bootloader.bin",
      partitions: "n16r8/partitions.bin",
      firmware: "n16r8/firmware.bin"
    }),
    offsets: Object.freeze({
      bootloader: 0x0000,
      partitions: 0x8000,
      firmware: 0x20000
    })
  }),
  esp32: Object.freeze({
    id: "esp32",
    label: "Classic ESP32",
    chipFamily: "ESP32",
    memory: "4 MB flash",
    recommended: false,
    releaseObject: "release.json",
    files: Object.freeze({
      bootloader: "bootloader.bin",
      partitions: "partitions.bin",
      firmware: "firmware.bin"
    }),
    offsets: Object.freeze({
      bootloader: 0x1000,
      partitions: 0x8000,
      firmware: 0x20000
    })
  })
});

export function getFirmwareTarget(id) {
  return typeof id === "string" && Object.hasOwn(FIRMWARE_TARGETS, id)
    ? FIRMWARE_TARGETS[id]
    : null;
}
