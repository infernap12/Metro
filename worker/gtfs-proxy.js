// Adelaide Metro GTFS proxy — Cloudflare Worker (Service Worker format).
//
// Deploy without any build tooling:
//   1. dash.cloudflare.com → Workers & Pages → Create → Start with Hello World
//      → Deploy. This gives you an initial *.workers.dev URL.
//   2. On the worker's page, click "Edit code".
//   3. Replace the entire editor contents with this file. Click "Deploy".
//   4. Copy the worker URL and paste it into the GTFS app's Settings.
//
// Why Service Worker format (addEventListener) instead of `export default`?
// The dashboard's drag-and-drop uploader rejects ES modules as "needs build".
// This format pastes into the inline editor cleanly.
//
// Free tier: 100,000 requests/day.

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

function corsHeaders(extra) {
  const h = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "*",
    "access-control-expose-headers": "*",
    "access-control-max-age": "86400",
  };
  if (extra) Object.assign(h, extra);
  return h;
}

async function handle(request) {
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
  const extra = corsHeaders();
  for (const k in extra) headers.set(k, extra[k]);

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers,
  });
}

addEventListener("fetch", (event) => {
  event.respondWith(handle(event.request));
});
