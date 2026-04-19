# Adelaide Metro GTFS Explorer

A **client-only** visualisation tool for the [Adelaide Metro GTFS + GTFS-realtime API](https://gtfs.adelaidemetro.com.au/).

- Live vehicle markers on a Leaflet map (arrow = heading, colour = `route_color`), auto-refreshing every 15 s.
- Routes panel sorted by live vehicle count — click to filter.
- Trip updates sorted by biggest delay.
- Service alerts with affected routes.
- Optional stops + per-route shape overlays (pulled from the static GTFS zip).

Everything runs in the browser: GTFS-realtime protobuf is decoded with
[protobuf.js] against the standard `gtfs-realtime.proto`, and the static zip is
unpacked with [JSZip]. No backend of your own is required — but the upstream
API does not send CORS headers, so the browser needs a tiny pass-through proxy
in front of it.

[protobuf.js]: https://github.com/protobufjs/protobuf.js
[JSZip]: https://stuk.github.io/jszip/

## Deploy

### 1. Host the static site (GitHub Pages)

1. Push this branch to GitHub.
2. Repo → Settings → Pages → **Source: Deploy from a branch**,
   pick this branch and **/ (root)**. Save.
3. Wait ~30 s. You'll get a `https://<user>.github.io/<repo>/` URL.

Any other static host works too (Cloudflare Pages, Netlify, Vercel, `python -m
http.server`, …).

### 2. Deploy the proxy (Cloudflare Worker, free)

The Worker is ~40 lines and just passes the allow-listed paths through to
`gtfs.adelaidemetro.com.au` with CORS headers. Free tier is 100,000 requests
per day.

1. Go to <https://dash.cloudflare.com/> and sign up if you haven't (no card needed).
2. **Workers & Pages → Create → Start with Hello World → Deploy**. This gives
   you a `*.workers.dev` URL. (Don't use the drag-and-drop uploader — it
   rejects single-file workers as "needs a build".)
3. Open the new worker, click **Edit code**, replace the editor contents with
   the whole of [`worker/gtfs-proxy.js`](worker/gtfs-proxy.js), then
   **Deploy**.
4. Copy the worker URL (e.g. `https://gtfs-proxy.yourname.workers.dev`).

### 3. Point the app at the proxy

Open the GitHub Pages URL. On first load you'll see a setup panel — paste the
worker URL and hit **Save**. The setting is stored in `localStorage`. You can
change it later via the **Settings** button.

## Run locally

No build step; any static file server works:

```bash
python3 -m http.server 8000
# or
npx serve .
```

Then open <http://localhost:8000>. You still need a proxy URL pointed at the
upstream API — deploy the Worker as above and paste the URL.

## Files

| Path | Purpose |
| --- | --- |
| `index.html`, `app.js`, `style.css` | Single-page frontend. |
| `gtfs-realtime.proto` | Standard GTFS-realtime proto (loaded at runtime, same-origin). |
| `worker/gtfs-proxy.js` | Cloudflare Worker script — paste into the CF dashboard. |

## Notes

- Adelaide Metro's `tfnsw_vehicle_descriptor` protobuf extension (air
  conditioning, wheelchair access) is not decoded; the standard proto only.
- The static GTFS zip is only downloaded the first time you enable the stops
  or shape overlay, and re-downloaded when `version.txt` changes.
- The Worker allow-lists only the upstream GTFS paths, so it can't be used as
  a general-purpose open proxy.
