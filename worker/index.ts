const INSTALLER_PATH =
  /^downloads\/v\d+\.\d+\.\d+-[0-9a-f]{7}\/[A-Za-z0-9][A-Za-z0-9._-]*\.(msi|pkg|zip)$/;
const METADATA_PATH =
  /^(downloads\/latest\.json|updates\/appcast(?:-macos)?\.xml(?:\.signature)?)$/;
const ADMIN_API_PREFIX = "/api/admin/";
const GITHUB_REPOSITORY = "matteo-avigni/Skynet";
const GITHUB_WORKFLOW = "publish-update-feeds.yml";

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
  if (!env.SKYNET_ADMIN_TOKEN || !env.GITHUB_WORKFLOW_TOKEN) {
    return jsonResponse({ error: "Admin publishing is not configured." }, 503);
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

async function handleAdminApi(request: Request, env: WorkerEnv, pathname: string): Promise<Response> {
  const authenticationFailure = await authenticateAdmin(request, env);
  if (authenticationFailure !== null) return authenticationFailure;

  if (pathname === `${ADMIN_API_PREFIX}publish` && request.method === "POST") {
    return dispatchUpdateFeedWorkflow(env);
  }

  if (pathname === `${ADMIN_API_PREFIX}runs` && request.method === "GET") {
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
