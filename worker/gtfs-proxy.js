// Adelaide Metro GTFS proxy — Cloudflare Worker
//
// Deploy:
//   1. cloudflare.com → Workers & Pages → Create → Worker → paste this file
//   2. Deploy. Copy the *.workers.dev URL.
//   3. In the web app's Settings, paste that URL as the proxy base.
//
// Free tier: 100,000 requests/day. More than enough for a personal dashboard.

const UPSTREAM = "https://gtfs.adelaidemetro.com.au";

// Only allow paths that match the upstream API surface.
const ALLOW = [
  /^\/v1\/realtime\/vehicle_positions(\/debug)?$/,
  /^\/v1\/realtime\/trip_updates(\/debug)?$/,
  /^\/v1\/realtime\/service_alerts(\/debug)?$/,
  /^\/v1\/realtime\/adelaidemetro_gtfsr\.proto$/,
  /^\/v1\/static\/latest\/version\.txt$/,
  /^\/v1\/static\/latest\/google_transit\.zip$/,
  /^\/v1\/static\/\d+\/google_transit\.zip$/,
];

function corsHeaders(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "*",
    "access-control-max-age": "86400",
    ...extra,
  };
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "GET") {
      return new Response("method not allowed", { status: 405, headers: corsHeaders() });
    }

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/healthz") {
      return new Response(
        JSON.stringify({ ok: true, upstream: UPSTREAM, allow: ALLOW.map(r => r.source) }),
        { headers: corsHeaders({ "content-type": "application/json" }) },
      );
    }

    if (!ALLOW.some(r => r.test(url.pathname))) {
      return new Response("path not allowed", { status: 403, headers: corsHeaders() });
    }

    const upstreamUrl = UPSTREAM + url.pathname + url.search;
    const upstreamRes = await fetch(upstreamUrl, {
      cf: { cacheTtl: 10, cacheEverything: true },
    });

    const headers = new Headers(upstreamRes.headers);
    for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
    // Browsers won't read arbitrary response headers without this.
    headers.set("access-control-expose-headers", "*");

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers,
    });
  },
};
