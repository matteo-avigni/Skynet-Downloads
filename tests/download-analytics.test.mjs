import assert from "node:assert/strict";
import test from "node:test";

import { downloadDataPoint, downloadIdentity } from "../worker/download-analytics.ts";

const windowsKey = "downloads/v0.1.14-89d480a/skynet-win-x64.msi";
const macosKey = "downloads/v0.1.14-89d480a/skynet-0.1.14-macos-universal.pkg";
const linuxKey = "downloads/v0.1.14-89d480a/skynet-0.1.14-linux-x64.deb";

test("extracts release and platform from installer keys", () => {
  assert.deepEqual(downloadIdentity(windowsKey), {
    version: "0.1.14",
    build: "89d480a",
    tag: "v0.1.14-89d480a",
    platform: "windows",
  });
  assert.equal(downloadIdentity(macosKey)?.platform, "macos");
  assert.equal(downloadIdentity(linuxKey)?.platform, "linux");
  assert.equal(downloadIdentity("downloads/latest.json"), null);
});

test("records full installer responses as public download starts", () => {
  const point = downloadDataPoint(new Request("https://example.test/file"), windowsKey, 2048, null);

  assert.deepEqual(point, {
    indexes: ["v0.1.14-89d480a"],
    blobs: ["windows", "0.1.14", "89d480a", "full", "public", windowsKey],
    doubles: [2048, 2048],
  });
});

test("distinguishes byte-zero starts from resumed ranges", () => {
  const request = new Request("https://example.test/file");
  const start = downloadDataPoint(request, macosKey, 4096, { offset: 0, length: 512 });
  const resume = downloadDataPoint(request, macosKey, 4096, { offset: 512, length: 512 });

  assert.equal(start?.blobs[3], "range_start");
  assert.equal(resume?.blobs[3], "range_resume");
  assert.deepEqual(start?.doubles, [4096, 512]);
});

test("marks synthetic verification traffic separately", () => {
  const request = new Request("https://example.test/file", {
    headers: { "X-Skynet-Verification": "1" },
  });
  const point = downloadDataPoint(request, linuxKey, 1024, { offset: 0, length: 32 });

  assert.equal(point?.blobs[4], "verification");
});
