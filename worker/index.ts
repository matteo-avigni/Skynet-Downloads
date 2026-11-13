const INSTALLER_PATH =
  /^downloads\/v\d+\.\d+\.\d+-[0-9a-f]{7}\/[A-Za-z0-9][A-Za-z0-9._-]*\.(msi|pkg|zip)$/;

type ByteRange = {
  offset: number;
  length: number;
};

function securityHeaders(headers: Headers): Headers {
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Security-Policy", "default-src 'none'");
  headers.set("Cross-Origin-Resource-Policy", "same-site");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Strict-Transport-Security", "max-age=31536000");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

function decodeInstallerKey(pathname: string): string | null {
  try {
    const key = decodeURIComponent(pathname).replace(/^\/+/, "");
    return INSTALLER_PATH.test(key) ? key : null;
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

function objectHeaders(object: R2Object, contentLength: number): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Length", String(contentLength));
  headers.set("ETag", object.httpEtag);
  return securityHeaders(headers);
}

async function serveInstaller(request: Request, env: Env, key: string): Promise<Response> {
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
      ),
    });
  }

  if (request.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: objectHeaders(metadata, metadata.size),
    });
  }

  const object = await env.INSTALLERS.get(key, range === null ? undefined : { range });
  if (object === null) return new Response("Not Found", { status: 404 });

  const headers = objectHeaders(object, range?.length ?? object.size);
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

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/downloads/")) return env.ASSETS.fetch(request);

    const key = decodeInstallerKey(url.pathname);
    if (key === null) return new Response("Not Found", { status: 404 });
    return serveInstaller(request, env, key);
  },
} satisfies ExportedHandler<Env>;

