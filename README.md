# ProxyKurd — HLS Proxy

Cloudflare Worker proxy for HTTP/HTTPS HLS playlists (.m3u8) and MPEG-TS segments (.ts).

## Deploy
1. Install Node.js.
2. Run `npm install`.
3. Authenticate with Cloudflare: `npx wrangler login`.
4. Deploy: `npm run deploy`.

## Usage
Encode the complete upstream URL as the `url` query parameter:

```text
https://YOUR-WORKER.workers.dev/proxy?url=https%3A%2F%2Fexample.com%2Flive%2Findex.m3u8
https://YOUR-WORKER.workers.dev/proxy?url=http%3A%2F%2Fexample.com%2Flive%2Fsegment001.ts
```

Playlist links to .m3u8/.ts resources are rewritten through the proxy, Range requests are forwarded, and CORS headers are included for browser players.

## Security
An open proxy can be abused. This version blocks obvious private/local destinations, but that is not a complete SSRF defense. Before public use, add an explicit upstream hostname allowlist and authentication/rate limiting. Use only streams you are authorized to access. This does not bypass DRM, logins, or provider restrictions.
