const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Origin, Accept, Content-Type",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, X-ProxyKurd-Upstream-Status"
};

const blockedHost = (hostValue) => {
  const host = hostValue.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host === "::1" || host === "0.0.0.0" || host.startsWith("fc") ||
      host.startsWith("fd") || host.startsWith("fe80:")) return true;
  const parts = host.split(".");
  if (parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    const [a, b] = parts.map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127)) return true;
  }
  return false;
};

const errorResponse = (message, status = 400) => new Response(
  JSON.stringify({ error: message }),
  { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } }
);

const mediaType = (url) => {
  const path = url.pathname.toLowerCase().split(";")[0];
  if (path.endsWith(".m3u8")) return "m3u8";
  if (path.endsWith(".ts")) return "ts";
  return "";
};

export default {
  async fetch(request) {
    const here = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!["GET", "HEAD"].includes(request.method)) return errorResponse("Only GET, HEAD, OPTIONS are supported.", 405);
    if (here.pathname === "/") {
      return new Response("ProxyKurd online. Use /proxy?url=<encoded HTTP(S) URL> for .m3u8 playlists or .ts segments.\n", {
        headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" }
      });
    }
    if (here.pathname !== "/proxy") return errorResponse("Not found.", 404);

    const raw = here.searchParams.get("url");
    if (!raw) return errorResponse("Missing url query parameter.");
    if (raw.length > 4096) return errorResponse("URL too long.", 414);

    let target;
    try { target = new URL(raw); } catch { return errorResponse("Provide a valid absolute URL."); }
    if (!["http:", "https:"].includes(target.protocol)) return errorResponse("Only HTTP and HTTPS URLs are allowed.");
    if (target.username || target.password) return errorResponse("URLs with embedded credentials are not allowed.");
    if (blockedHost(target.hostname)) return errorResponse("Private/local hostnames are blocked.");

    const requestedType = mediaType(target);
    if (!requestedType) return errorResponse("Only .m3u8 and .ts paths are supported.");

    // Forward ordinary playback headers instead of identifying every request as a custom proxy.
    const requestHeaders = new Headers();
    requestHeaders.set("User-Agent", request.headers.get("User-Agent") || "Mozilla/5.0");
    for (const header of ["Range", "Accept", "Accept-Language"]) {
      if (request.headers.has(header)) requestHeaders.set(header, request.headers.get(header));
    }

    let upstream;
    try {
      for (let i = 0; i <= 4; i++) {
        upstream = await fetch(target.toString(), {
          method: request.method,
          headers: requestHeaders,
          redirect: "manual"
        });
        if (![301, 302, 303, 307, 308].includes(upstream.status)) break;

        const location = upstream.headers.get("Location");
        if (!location || i === 4) return errorResponse("Too many or invalid upstream redirects.", 502);
        const next = new URL(location, target);
        if (!["http:", "https:"].includes(next.protocol) || next.username || next.password || blockedHost(next.hostname)) {
          return errorResponse("Redirect destination is not allowed.", 502);
        }
        target = next;
      }
    } catch {
      return errorResponse("Could not fetch upstream resource.", 502);
    }

    const headers = new Headers(CORS);
    for (const header of ["content-length", "content-range", "accept-ranges", "last-modified", "etag", "cache-control", "expires"]) {
      if (upstream.headers.has(header)) headers.set(header, upstream.headers.get(header));
    }
    headers.set("X-ProxyKurd-Upstream-Status", String(upstream.status));
    headers.set("Content-Type", requestedType === "m3u8" ? "application/vnd.apple.mpegurl" : "video/mp2t");
    headers.set("X-Content-Type-Options", "nosniff");

    // Surface upstream errors clearly; don't label an error page as a valid playlist/segment.
    if (!upstream.ok) {
      const errorText = request.method === "HEAD" ? "" : (await upstream.text()).slice(0, 1000);
      return new Response(JSON.stringify({
        error: "Upstream server rejected or failed the request.",
        upstreamStatus: upstream.status,
        upstreamStatusText: upstream.statusText,
        details: errorText
      }), {
        status: upstream.status,
        headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "X-ProxyKurd-Upstream-Status": String(upstream.status) }
      });
    }

    if (requestedType === "m3u8" && request.method !== "HEAD") {
      let body = await upstream.text();
      const rewriteResource = (value) => {
        const trimmed = value.trim();
        if (!trimmed || trimmed.startsWith("#")) return value;
        try {
          const resolved = new URL(trimmed, target);
          if (!mediaType(resolved)) return value;
          const proxyUrl = new URL("/proxy", here.origin);
          proxyUrl.searchParams.set("url", resolved.toString());
          return proxyUrl.toString();
        } catch { return value; }
      };

      body = body.split(/\r?\n/).map(line => line.trim().startsWith("#")
        ? line.replace(/URI="([^"]+)"/g, (_, uri) => 'URI="' + rewriteResource(uri) + '"')
        : rewriteResource(line)).join("\n");
      headers.delete("Content-Length");
      headers.delete("Content-Range");
      return new Response(body, { status: upstream.status, headers });
    }

    return new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers });
  }
};
