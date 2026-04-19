const path = require("path");
const express = require("express");
const AdmZip = require("adm-zip");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");

const FeedMessage = GtfsRealtimeBindings.transit_realtime.FeedMessage;

const UPSTREAM = "https://gtfs.adelaidemetro.com.au/v1";
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

// --- in-memory caches --------------------------------------------------------

const realtimeCache = {
  vehicles: { data: null, ts: 0, ttlMs: 10_000 },
  trip_updates: { data: null, ts: 0, ttlMs: 30_000 },
  alerts: { data: null, ts: 0, ttlMs: 60_000 },
};

const staticCache = {
  version: null,
  files: {}, // filename -> string contents
  fetchedAt: 0,
};

// --- helpers -----------------------------------------------------------------

async function fetchProto(pathname) {
  const res = await fetch(`${UPSTREAM}${pathname}`);
  if (!res.ok) throw new Error(`Upstream ${res.status} for ${pathname}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const msg = FeedMessage.decode(buf);
  return FeedMessage.toObject(msg, { longs: Number, enums: String, defaults: false });
}

async function cachedRealtime(key, pathname) {
  const c = realtimeCache[key];
  const now = Date.now();
  if (c.data && now - c.ts < c.ttlMs) return c.data;
  const data = await fetchProto(pathname);
  c.data = data;
  c.ts = now;
  return data;
}

async function getStaticVersion() {
  const res = await fetch(`${UPSTREAM}/static/latest/version.txt`);
  if (!res.ok) throw new Error(`version.txt ${res.status}`);
  return (await res.text()).trim();
}

async function ensureStatic() {
  const latest = await getStaticVersion();
  if (staticCache.version === latest && Object.keys(staticCache.files).length) {
    return staticCache;
  }
  const res = await fetch(`${UPSTREAM}/static/latest/google_transit.zip`);
  if (!res.ok) throw new Error(`zip ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);
  const files = {};
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    files[entry.entryName] = entry.getData().toString("utf8");
  }
  staticCache.version = latest;
  staticCache.files = files;
  staticCache.fetchedAt = Date.now();
  // Rebuild derived indexes on refresh.
  staticCache.parsed = {};
  return staticCache;
}

function parseCsv(text) {
  // RFC 4180-ish parser: supports quoted fields, escaped quotes, CRLF.
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (ch === "\r") { /* skip */ }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows.shift();
  return rows
    .filter(r => r.length > 1 || (r.length === 1 && r[0] !== ""))
    .map(r => {
      const obj = {};
      for (let i = 0; i < header.length; i++) obj[header[i]] = r[i];
      return obj;
    });
}

function getParsed(filename) {
  staticCache.parsed ??= {};
  if (staticCache.parsed[filename]) return staticCache.parsed[filename];
  const text = staticCache.files[filename];
  if (!text) return null;
  const parsed = parseCsv(text);
  staticCache.parsed[filename] = parsed;
  return parsed;
}

// --- realtime endpoints ------------------------------------------------------

app.get("/api/vehicles", async (_req, res) => {
  try {
    const feed = await cachedRealtime("vehicles", "/realtime/vehicle_positions");
    const vehicles = (feed.entity || [])
      .filter(e => e.vehicle && e.vehicle.position)
      .map(e => {
        const v = e.vehicle;
        return {
          id: e.id,
          tripId: v.trip?.tripId,
          routeId: v.trip?.routeId,
          directionId: v.trip?.directionId,
          startDate: v.trip?.startDate,
          lat: v.position.latitude,
          lon: v.position.longitude,
          bearing: v.position.bearing,
          speed: v.position.speed,
          vehicleId: v.vehicle?.id,
          vehicleLabel: v.vehicle?.label,
          timestamp: v.timestamp,
        };
      });
    res.json({ header: feed.header, count: vehicles.length, vehicles });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.get("/api/trip-updates", async (_req, res) => {
  try {
    const feed = await cachedRealtime("trip_updates", "/realtime/trip_updates");
    const updates = (feed.entity || [])
      .filter(e => e.tripUpdate)
      .map(e => {
        const tu = e.tripUpdate;
        const stus = tu.stopTimeUpdate || [];
        const delays = stus
          .map(s => s.arrival?.delay ?? s.departure?.delay)
          .filter(d => typeof d === "number");
        const maxDelay = delays.length ? delays.reduce((a, b) => Math.abs(a) > Math.abs(b) ? a : b) : null;
        return {
          id: e.id,
          tripId: tu.trip?.tripId,
          routeId: tu.trip?.routeId,
          directionId: tu.trip?.directionId,
          startDate: tu.trip?.startDate,
          vehicleId: tu.vehicle?.id,
          vehicleLabel: tu.vehicle?.label,
          timestamp: tu.timestamp,
          stopCount: stus.length,
          maxDelay,
          stopTimeUpdates: stus.map(s => ({
            stopId: s.stopId,
            stopSequence: s.stopSequence,
            arrivalDelay: s.arrival?.delay,
            arrivalTime: s.arrival?.time,
            departureDelay: s.departure?.delay,
            departureTime: s.departure?.time,
            scheduleRelationship: s.scheduleRelationship,
          })),
        };
      });
    res.json({ header: feed.header, count: updates.length, updates });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.get("/api/alerts", async (_req, res) => {
  try {
    const feed = await cachedRealtime("alerts", "/realtime/service_alerts");
    const alerts = (feed.entity || [])
      .filter(e => e.alert)
      .map(e => {
        const a = e.alert;
        const txt = (tr) => (tr?.translation?.[0]?.text) || null;
        return {
          id: e.id,
          cause: a.cause,
          effect: a.effect,
          headerText: txt(a.headerText),
          descriptionText: txt(a.descriptionText),
          url: txt(a.url),
          activePeriod: (a.activePeriod || []).map(p => ({ start: p.start, end: p.end })),
          informedEntity: (a.informedEntity || []).map(ie => ({
            agencyId: ie.agencyId,
            routeId: ie.routeId,
            routeType: ie.routeType,
            stopId: ie.stopId,
            trip: ie.trip,
          })),
        };
      });
    res.json({ header: feed.header, count: alerts.length, alerts });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// --- static endpoints --------------------------------------------------------

app.get("/api/static/version", async (_req, res) => {
  try {
    const v = await getStaticVersion();
    res.json({ version: v, cachedVersion: staticCache.version });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.get("/api/static/routes", async (_req, res) => {
  try {
    await ensureStatic();
    res.json({ version: staticCache.version, routes: getParsed("routes.txt") || [] });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.get("/api/static/stops", async (_req, res) => {
  try {
    await ensureStatic();
    const stops = (getParsed("stops.txt") || []).map(s => ({
      stop_id: s.stop_id,
      stop_code: s.stop_code,
      stop_name: s.stop_name,
      stop_lat: parseFloat(s.stop_lat),
      stop_lon: parseFloat(s.stop_lon),
      location_type: s.location_type,
      parent_station: s.parent_station,
      zone_id: s.zone_id,
    })).filter(s => Number.isFinite(s.stop_lat) && Number.isFinite(s.stop_lon));
    res.json({ version: staticCache.version, count: stops.length, stops });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.get("/api/static/shapes/:routeId", async (req, res) => {
  try {
    await ensureStatic();
    const routeId = req.params.routeId;
    const trips = getParsed("trips.txt") || [];
    const shapes = getParsed("shapes.txt") || [];
    const shapeIds = new Set(
      trips.filter(t => t.route_id === routeId && t.shape_id).map(t => t.shape_id)
    );
    if (!shapeIds.size) return res.json({ routeId, shapes: [] });

    // Group shape points by shape_id.
    const grouped = {};
    for (const row of shapes) {
      if (!shapeIds.has(row.shape_id)) continue;
      (grouped[row.shape_id] ??= []).push({
        seq: parseInt(row.shape_pt_sequence, 10),
        lat: parseFloat(row.shape_pt_lat),
        lon: parseFloat(row.shape_pt_lon),
      });
    }
    const out = Object.entries(grouped).map(([shape_id, points]) => ({
      shape_id,
      points: points
        .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon))
        .sort((a, b) => a.seq - b.seq)
        .map(p => [p.lat, p.lon]),
    }));
    res.json({ routeId, count: out.length, shapes: out });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// --- fallback ----------------------------------------------------------------

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    upstream: UPSTREAM,
    cache: {
      staticVersion: staticCache.version,
      realtimeAges: Object.fromEntries(
        Object.entries(realtimeCache).map(([k, c]) => [k, c.ts ? Date.now() - c.ts : null])
      ),
    },
  });
});

app.listen(PORT, () => {
  console.log(`Adelaide Metro GTFS viz listening on http://localhost:${PORT}`);
});
