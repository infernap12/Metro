# Adelaide Metro GTFS Explorer

A visualisation tool for the [Adelaide Metro GTFS + GTFS-realtime API](https://gtfs.adelaidemetro.com.au/).

It runs a small Node proxy that:

- Downloads and decodes the GTFS-realtime protobuf feeds
  (vehicle positions, trip updates, service alerts).
- Caches and parses the static GTFS zip (routes, stops, shapes, trips) on demand.

…and serves a Leaflet-based UI with:

- Live vehicle markers (arrow shows bearing, colour comes from `route_color` where
  available, otherwise hashed from `route_id`) that update every 15 seconds.
- A route list sorted by live vehicle count — click a route to filter the map.
- A trip-updates panel sorted by largest delay.
- A service-alerts panel with affected routes.
- Optional stops layer and per-route shape overlay from the static feed.

The upstream API does not send CORS headers, so a server-side proxy is required;
everything else is plain static HTML/CSS/JS with Leaflet from a CDN.

## Run

Requires Node 18+.

```bash
npm install
npm start
```

Then open <http://localhost:3000>.

Set `PORT` to override the port:

```bash
PORT=8080 npm start
```

## API the proxy exposes

| Path | Description |
| --- | --- |
| `GET /api/vehicles` | Decoded vehicle positions feed (cached 10 s). |
| `GET /api/trip-updates` | Decoded trip updates feed (cached 30 s), with each trip's max delay. |
| `GET /api/alerts` | Decoded service alerts (cached 60 s). |
| `GET /api/static/version` | Current `version.txt` from upstream. |
| `GET /api/static/routes` | `routes.txt` parsed as JSON. |
| `GET /api/static/stops` | `stops.txt` parsed and coerced to numbers. |
| `GET /api/static/shapes/:routeId` | All shapes for any trip using `routeId`. |
| `GET /api/health` | Cache status. |

The static GTFS zip is downloaded on first use and kept in memory; a new
`version.txt` value triggers a refresh.

## Notes

- Only the standard GTFS-realtime protobuf fields are decoded. Adelaide Metro's
  `tfnsw_vehicle_descriptor` extension (air conditioning, wheelchair access) is
  ignored; add the custom `.proto` if you need those fields.
- `route_id` values include numeric bus routes (`202`), train lines, and
  lettered services like `BTANIC`.
