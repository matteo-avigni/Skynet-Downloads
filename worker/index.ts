const INSTALLER_PATH =
  /^downloads\/v\d+\.\d+\.\d+-[0-9a-f]{7}\/[A-Za-z0-9][A-Za-z0-9._-]*\.(msi|pkg|deb|zip)$/;
const METADATA_PATH =
  /^(downloads\/latest\.json|updates\/appcast(?:-macos)?\.xml(?:\.signature)?)$/;
const ADMIN_API_PREFIX = "/api/admin/";
const GITHUB_REPOSITORY = "matteo-avigni/Skynet";
const GITHUB_WORKFLOW = "publish-update-feeds.yml";
const PUBLIC_ORIGIN = "https://skynet.matteo-avigni.com";
const PORTFOLIO_ORIGIN = "https://matteo-avigni.com";
const MAX_INSTALLER_SIZE = 100_000_000;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const BUILD_PATTERN = /^[0-9a-f]{7}$/;

type WorkerEnv = Env & {
  GITHUB_WORKFLOW_TOKEN?: string;
  SKYNET_ADMIN_TOKEN?: string;
};

type ByteRange = {
  offset: number;
  length: number;
};

type GitHubWorkflowRun = {
  id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  head_sha: string;
  display_title: string;
};

type GitHubWorkflowRunsResponse = {
  workflow_runs: GitHubWorkflowRun[];
};

type InstallerPlatform = "windows" | "macos" | "linux";

type ReleaseManifest = {
  version: string;
  build: string;
  tag: string;
  publishedUtc: string;
  windows: {
    path: string;
    signed: boolean;
  };
  macos: {
    path: string;
  };
  linux: {
    path: string;
  };
};

type PublishPackagesRequest = {
  version?: unknown;
  build?: unknown;
  windowsSigned?: unknown;
};

function securityHeaders(headers: Headers, acceptsRanges = false): Headers {
  if (acceptsRanges) headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Security-Policy", "default-src 'none'");
  headers.set("Cross-Origin-Resource-Policy", "same-site");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Strict-Transport-Security", "max-age=31536000");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: securityHeaders(
      new Headers({
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      }),
    ),
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

function releaseIdentity(versionValue: string | null, buildValue: string | null): {
  version: string;
  build: string;
  tag: string;
} | null {
  const version = versionValue?.trim() ?? "";
  const build = buildValue?.trim().toLowerCase() ?? "";
  if (!VERSION_PATTERN.test(version) || !BUILD_PATTERN.test(build)) return null;
  return { version, build, tag: `v${version}-${build}` };
}

function installerFilename(platform: InstallerPlatform, version: string): string {
  if (platform === "windows") return "skynet-win-x64.msi";
  if (platform === "macos") return `skynet-${version}-macos-universal.pkg`;
  return `skynet-${version}-linux-x64.deb`;
}

function installerKey(platform: InstallerPlatform, version: string, tag: string): string {
  return `downloads/${tag}/${installerFilename(platform, version)}`;
}

function parsePlatform(value: string | null): InstallerPlatform | null {
  return value === "windows" || value === "macos" || value === "linux" ? value : null;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

async function currentManifest(env: WorkerEnv): Promise<ReleaseManifest | null> {
  const object = await env.INSTALLERS.get("downloads/latest.json");
  if (object === null) return null;

  try {
    return (await object.json()) as ReleaseManifest;
  } catch {
    return null;
  }
}

async function validateReleaseAdvance(
  env: WorkerEnv,
  version: string,
  tag: string,
): Promise<Response | null> {
  const current = await currentManifest(env);
  if (current === null || current.tag === tag) return null;
  if (current.version === version) {
    return errorResponse(
      `Version ${version} is already published with build ${current.build}. Increment the version first.`,
      409,
    );
  }
  if (VERSION_PATTERN.test(current.version) && compareVersions(version, current.version) < 0) {
    return errorResponse(`Version ${version} is older than current version ${current.version}.`, 409);
  }
  return null;
}

function decodePublicKey(pathname: string): string | null {
  try {
    const key = decodeURIComponent(pathname).replace(/^\/+/, "");
    return INSTALLER_PATH.test(key) || METADATA_PATH.test(key) ? key : null;
  } catch {
    return null;
  }
}

function parseByteRange(value: string | null, size: number): ByteRange | null | false {
  if (value === null) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (match === null || (match[1] === "" && match[2] === "")) return false;

  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }

  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= size) return false;

  const requestedEnd = match[2] === "" ? size - 1 : Number(match[2]);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < offset) return false;

  const end = Math.min(requestedEnd, size - 1);
  return { offset, length: end - offset + 1 };
}

function etagMatches(value: string, etag: string): boolean {
  return value
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || candidate === etag || candidate === `W/${etag}`);
}

function preconditionResponse(request: Request, object: R2Object): Response | null {
  const ifMatch = request.headers.get("If-Match");
  if (ifMatch !== null && !etagMatches(ifMatch, object.httpEtag)) {
    return new Response(null, {
      status: 412,
      headers: securityHeaders(new Headers({ ETag: object.httpEtag })),
    });
  }

  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch !== null && etagMatches(ifNoneMatch, object.httpEtag)) {
    return new Response(null, {
      status: 304,
      headers: securityHeaders(new Headers({ ETag: object.httpEtag })),
    });
  }

  return null;
}

function installerHeaders(object: R2Object, contentLength: number): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Length", String(contentLength));
  headers.set("ETag", object.httpEtag);
  return securityHeaders(headers, true);
}

function metadataHeaders(object: R2Object, key: string): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Length", String(object.size));
  headers.set("Content-Type", metadataContentType(key));
  headers.set("ETag", object.httpEtag);
  // Lets the portfolio's /skynet-downloads/ page read the current release.
  if (key === "downloads/latest.json") {
    headers.set("Access-Control-Allow-Origin", PORTFOLIO_ORIGIN);
  }
  return securityHeaders(headers);
}

function metadataContentType(key: string): string {
  if (key.endsWith(".json")) return "application/json; charset=utf-8";
  if (key.endsWith(".signature")) return "text/plain; charset=utf-8";
  return "application/xml; charset=utf-8";
}

async function serveInstaller(request: Request, env: WorkerEnv, key: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  const metadata = await env.INSTALLERS.head(key);
  if (metadata === null) return new Response("Not Found", { status: 404 });

  const precondition = preconditionResponse(request, metadata);
  if (precondition !== null) return precondition;

  let range = parseByteRange(request.headers.get("Range"), metadata.size);
  const ifRange = request.headers.get("If-Range");
  if (range && ifRange !== null && ifRange !== metadata.httpEtag) range = null;

  if (range === false) {
    return new Response(null, {
      status: 416,
      headers: securityHeaders(
        new Headers({
          "Content-Range": `bytes */${metadata.size}`,
          ETag: metadata.httpEtag,
        }),
        true,
      ),
    });
  }

  if (request.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: installerHeaders(metadata, metadata.size),
    });
  }

  const object = await env.INSTALLERS.get(key, range === null ? undefined : { range });
  if (object === null) return new Response("Not Found", { status: 404 });

  const headers = installerHeaders(object, range?.length ?? object.size);
  if (range !== null) {
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`,
    );
  }

  return new Response(object.body, {
    status: range === null ? 200 : 206,
    headers,
  });
}

async function serveMetadata(request: Request, env: WorkerEnv, key: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  const object = await env.INSTALLERS.get(key);
  if (object === null) return new Response("Not Found", { status: 404 });

  const precondition = preconditionResponse(request, object);
  if (precondition !== null) return precondition;

  return new Response(request.method === "HEAD" ? null : object.body, {
    status: 200,
    headers: metadataHeaders(object, key),
  });
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

function adminToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  const match = authorization === null ? null : /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(authorization);
  return match?.[1] ?? null;
}

function githubHeaders(token: string): Headers {
  return new Headers({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "skynet-downloads-admin",
    "X-GitHub-Api-Version": "2022-11-28",
  });
}

async function authenticateAdmin(request: Request, env: WorkerEnv): Promise<Response | null> {
  if (!env.SKYNET_ADMIN_TOKEN) {
    return errorResponse("Admin authentication is not configured.", 503);
  }

  const providedToken = adminToken(request);
  if (providedToken === null || !constantTimeEqual(providedToken, env.SKYNET_ADMIN_TOKEN)) {
    return new Response(null, {
      status: 401,
      headers: securityHeaders(new Headers({ "WWW-Authenticate": "Bearer" })),
    });
  }

  return null;
}

async function dispatchUpdateFeedWorkflow(env: WorkerEnv): Promise<Response> {
  if (!env.GITHUB_WORKFLOW_TOKEN) {
    return errorResponse("Updater publishing is not configured.", 503);
  }

  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: githubHeaders(env.GITHUB_WORKFLOW_TOKEN!),
      body: JSON.stringify({ ref: "main" }),
    },
  );

  if (!response.ok) {
    return jsonResponse({ error: "GitHub rejected the publish request." }, 502);
  }

  return jsonResponse({ status: "queued" }, 202);
}

async function listUpdateFeedRuns(env: WorkerEnv): Promise<Response> {
  if (!env.GITHUB_WORKFLOW_TOKEN) {
    return errorResponse("Updater publishing is not configured.", 503);
  }

  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/${GITHUB_WORKFLOW}/runs?event=workflow_dispatch&per_page=8`,
    {
      headers: githubHeaders(env.GITHUB_WORKFLOW_TOKEN!),
    },
  );

  if (!response.ok) {
    return jsonResponse({ error: "GitHub workflow status is unavailable." }, 502);
  }

  const payload = (await response.json()) as GitHubWorkflowRunsResponse;
  const runs = payload.workflow_runs.map((run) => ({
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    url: run.html_url,
    revision: run.head_sha.slice(0, 7),
    title: run.display_title,
  }));
  return jsonResponse({ runs });
}

async function uploadInstaller(
  request: Request,
  env: WorkerEnv,
  url: URL,
): Promise<Response> {
  const platform = parsePlatform(url.searchParams.get("platform"));
  const identity = releaseIdentity(
    url.searchParams.get("version"),
    url.searchParams.get("build"),
  );
  if (platform === null || identity === null) {
    return errorResponse("A valid platform, semantic version, and seven-character build are required.", 400);
  }

  const releaseFailure = await validateReleaseAdvance(env, identity.version, identity.tag);
  if (releaseFailure !== null) return releaseFailure;

  const expectedFilename = installerFilename(platform, identity.version);
  if (request.headers.get("X-Skynet-Filename") !== expectedFilename) {
    return errorResponse(`Expected installer filename ${expectedFilename}.`, 400);
  }

  const contentLength = Number(request.headers.get("Content-Length"));
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    return errorResponse("The installer size is missing or invalid.", 411);
  }
  if (contentLength > MAX_INSTALLER_SIZE) {
    return errorResponse("The installer exceeds the 100 MB upload limit.", 413);
  }
  if (request.body === null) {
    return errorResponse("The installer body is missing.", 400);
  }

  const key = installerKey(platform, identity.version, identity.tag);
  const existing = await env.INSTALLERS.head(key);
  if (existing !== null) {
    if (existing.size !== contentLength) {
      return errorResponse("An immutable installer already exists at this release path.", 409);
    }
    return jsonResponse({ platform, filename: expectedFilename, size: existing.size, alreadyPresent: true });
  }

  const contentType = platform === "windows"
    ? "application/x-msi"
    : platform === "macos"
      ? "application/vnd.apple.installer+xml"
      : "application/vnd.debian.binary-package";
  await env.INSTALLERS.put(key, request.body, {
    httpMetadata: {
      contentType,
      contentDisposition: `attachment; filename="${expectedFilename}"`,
      cacheControl: "public, max-age=31536000, immutable",
    },
  });

  const uploaded = await env.INSTALLERS.head(key);
  if (uploaded === null || uploaded.size !== contentLength) {
    return errorResponse("The installer upload could not be verified.", 502);
  }

  return jsonResponse({ platform, filename: expectedFilename, size: uploaded.size, alreadyPresent: false }, 201);
}

async function publishPackages(request: Request, env: WorkerEnv): Promise<Response> {
  let payload: PublishPackagesRequest;
  try {
    payload = (await request.json()) as PublishPackagesRequest;
  } catch {
    return errorResponse("The package publication request is invalid.", 400);
  }

  const identity = releaseIdentity(
    typeof payload.version === "string" ? payload.version : null,
    typeof payload.build === "string" ? payload.build : null,
  );
  if (identity === null || typeof payload.windowsSigned !== "boolean") {
    return errorResponse("A valid version, build, and Windows signing state are required.", 400);
  }

  const releaseFailure = await validateReleaseAdvance(env, identity.version, identity.tag);
  if (releaseFailure !== null) return releaseFailure;

  const windowsKey = installerKey("windows", identity.version, identity.tag);
  const macosKey = installerKey("macos", identity.version, identity.tag);
  const linuxKey = installerKey("linux", identity.version, identity.tag);
  const [windowsObject, macosObject, linuxObject] = await Promise.all([
    env.INSTALLERS.head(windowsKey),
    env.INSTALLERS.head(macosKey),
    env.INSTALLERS.head(linuxKey),
  ]);
  if (windowsObject === null || macosObject === null || linuxObject === null) {
    return errorResponse("The Windows MSI, macOS PKG, and Linux DEB must be uploaded before publishing.", 409);
  }

  const manifest: ReleaseManifest = {
    version: identity.version,
    build: identity.build,
    tag: identity.tag,
    publishedUtc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    windows: {
      path: `${PUBLIC_ORIGIN}/${windowsKey}`,
      signed: payload.windowsSigned,
    },
    macos: {
      path: `${PUBLIC_ORIGIN}/${macosKey}`,
    },
    linux: {
      path: `${PUBLIC_ORIGIN}/${linuxKey}`,
    },
  };
  await env.INSTALLERS.put(
    "downloads/latest.json",
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      httpMetadata: {
        contentType: "application/json; charset=utf-8",
        cacheControl: "no-store",
      },
    },
  );

  return jsonResponse({ release: manifest }, 201);
}

async function handleAdminApi(request: Request, env: WorkerEnv, pathname: string): Promise<Response> {
  const authenticationFailure = await authenticateAdmin(request, env);
  if (authenticationFailure !== null) return authenticationFailure;

  if (pathname === `${ADMIN_API_PREFIX}session` && request.method === "GET") {
    return jsonResponse({ authenticated: true });
  }

  if (pathname === `${ADMIN_API_PREFIX}packages/upload` && request.method === "POST") {
    return uploadInstaller(request, env, new URL(request.url));
  }

  if (pathname === `${ADMIN_API_PREFIX}packages/publish` && request.method === "POST") {
    return publishPackages(request, env);
  }

  if (pathname === `${ADMIN_API_PREFIX}updater/publish` && request.method === "POST") {
    return dispatchUpdateFeedWorkflow(env);
  }

  if (pathname === `${ADMIN_API_PREFIX}updater/runs` && request.method === "GET") {
    return listUpdateFeedRuns(env);
  }

  return new Response("Not Found", { status: 404 });
}

export default {
  async fetch(request, env): Promise<Response> {
    const workerEnv = env as WorkerEnv;
    const url = new URL(request.url);

    if (url.pathname.startsWith(ADMIN_API_PREFIX)) {
      return handleAdminApi(request, workerEnv, url.pathname);
    }

    if (url.pathname.startsWith("/downloads/") || url.pathname.startsWith("/updates/")) {
      const key = decodePublicKey(url.pathname);
      if (key === null) return new Response("Not Found", { status: 404 });
      return INSTALLER_PATH.test(key)
        ? serveInstaller(request, workerEnv, key)
        : serveMetadata(request, workerEnv, key);
    }

    return workerEnv.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
