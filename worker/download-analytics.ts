export const INSTALLER_PATH =
  /^downloads\/v(\d+\.\d+\.\d+)-([0-9a-f]{7})\/[A-Za-z0-9][A-Za-z0-9._-]*\.(msi|pkg|deb|zip)$/;

export type DownloadPlatform = "windows" | "macos" | "linux" | "portable";
type DownloadDelivery = "full" | "range_start" | "range_resume";

export type DownloadRange = {
  offset: number;
  length: number;
};

type DownloadIdentity = {
  version: string;
  build: string;
  tag: string;
  platform: DownloadPlatform;
};

export function downloadIdentity(key: string): DownloadIdentity | null {
  const match = INSTALLER_PATH.exec(key);
  if (match === null) return null;

  const [, version, build, extension] = match;
  const platform: DownloadPlatform = extension === "msi"
    ? "windows"
    : extension === "pkg"
      ? "macos"
      : extension === "deb"
        ? "linux"
        : "portable";
  return { version, build, tag: `v${version}-${build}`, platform };
}

export function downloadDataPoint(
  request: Request,
  key: string,
  size: number,
  range: DownloadRange | null,
): { indexes: string[]; blobs: string[]; doubles: number[] } | null {
  const identity = downloadIdentity(key);
  if (identity === null) return null;

  const delivery: DownloadDelivery = range === null
    ? "full"
    : range.offset === 0
      ? "range_start"
      : "range_resume";
  const source = request.headers.get("X-Skynet-Verification") === "1"
    ? "verification"
    : "public";

  return {
    indexes: [identity.tag],
    blobs: [
      identity.platform,
      identity.version,
      identity.build,
      delivery,
      source,
      key,
    ],
    doubles: [size, range?.length ?? size],
  };
}
