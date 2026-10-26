/**
 * HLS Proxy — Cloudflare Worker
 * GET /proxy?url=<URL-encoded HTTP(S) URL>
 * Supports .m3u8 playlists and .ts segments.
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Origin, Accept, Content-Type",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
};
const blockedHost = (hostname) => {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") ||
      h === "::1" || h === "0.0.0.0" || h.startsWith("fc") ||
      h.startsWith("fd") || h.startsWith("fe80:")) return true;
  const p = h.split(".");
  if (p.length === 4 && p.every(x => /^\d{1,3}$/.test(x) && +x <= 255)) {
    const [a,b] = p.map(Number);
    if (a===10 || a===127 || a===0 || (a===169&&b===254) ||
        (a===172&&b>=16&&b<=31) || (a===192&&b===168) ||
        (a===100&&b>=64&&b<=127)) return true;
  }
  return false;
};
const err = (message, status=400) => new Response(JSON.stringify({error:message}), {
  status, headers:{...CORS,"Content-Type":"application/json; charset=utf-8"}
});
export default {
  async fetch(request) {
    const here = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null,{status:204,headers:CORS});
    if (!["GET","HEAD"].includes(request.method)) return err("Only GET, HEAD, OPTIONS are supported.",405);
    if (here.pathname === "/") return new Response(
      "HLS proxy online. Use /proxy?url=<encoded HTTP(S) URL> for .m3u8 or .ts files.\n",
      {headers:{...CORS,"Content-Type":"text/plain; charset=utf-8"}}
    );
    if (here.pathname !== "/proxy") return err("Not found.",404);
    const raw = here.searchParams.get("url");
    if (!raw) return err("Missing url query parameter.");
    if (raw.length > 4096) return err("URL too long.",414);
    let target;
    try { target = new URL(raw); } catch { return err("Provide a valid absolute URL."); }
    if (!["http:","https:"].includes(target.protocol)) return err("Only HTTP and HTTPS URLs are allowed.");
    if (target.username || target.password) return err("URLs with embedded credentials are not allowed.");
    if (blockedHost(target.hostname)) return err("Private/local hostnames are blocked.");
    const ext = u => u.pathname.toLowerCase().endsWith(".m3u8") ? "m3u8" :
      u.pathname.toLowerCase().endsWith(".ts") ? "ts" : "";
    if (!ext(target)) return err("Only .m3u8 and .ts paths are supported.");
    const requestHeaders = new Headers({ "User-Agent":"HLS-Proxy/1.0" });
    for (const h of ["Range","Accept"]) if (request.headers.has(h)) requestHeaders.set(h,request.headers.get(h));
    let upstream;
    try {
      for (let i=0; i<=4; i++) {
        upstream = await fetch(target.toString(),{method:request.method,headers:requestHeaders,redirect:"manual"});
        if (![301,302,303,307,308].includes(upstream.status)) break;
        const loc = upstream.headers.get("Location");
        if (!loc || i===4) return err("Too many or invalid upstream redirects.",502);
        target = new URL(loc,target);
        if (!["http:","https:"].includes(target.protocol) || blockedHost(target.hostname) || !ext(target))
          return err("Redirect destination is not allowed.",502);
      }
    } catch { return err("Could not fetch upstream resource.",502); }
    const type = ext(target);
    const headers = new Headers(CORS);
    for (const h of ["content-length","content-range","accept-ranges","last-modified","etag","cache-control","expires"])
      if (upstream.headers.has(h)) headers.set(h,upstream.headers.get(h));
    headers.set("Content-Type",type==="m3u8"?"application/vnd.apple.mpegurl":"video/mp2t");
    headers.set("X-Content-Type-Options","nosniff");
    if (type==="m3u8" && upstream.ok && request.method!=="HEAD") {
      let body = await upstream.text();
      const proxy = (value) => {
        const s=value.trim();
        if (!s || s.startsWith("#")) return value;
        try {
          const resolved=new URL(s,target);
          if (!ext(resolved)) return value;
          const p=new URL("/proxy",here.origin); p.searchParams.set("url",resolved.toString());
          return p.toString();
        } catch { return value; }
      };
      body=body.split(/\r?\n/).map(line=>line.trim().startsWith("#")
        ? line.replace(/URI="([^"]+)"/g,(_,u)=>'URI="'+proxy(u)+'"')
        : proxy(line)).join("\n");
      headers.delete("Content-Length"); headers.delete("Content-Range");
      return new Response(body,{status:upstream.status,headers});
    }
    return new Response(request.method==="HEAD"?null:upstream.body,{status:upstream.status,headers});
  }
};
