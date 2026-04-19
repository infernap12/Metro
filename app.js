"use strict";

// --- proxy config ------------------------------------------------------------

const PROXY_KEY = "gtfs_proxy_url";

function getProxy() {
  return (localStorage.getItem(PROXY_KEY) || "").replace(/\/+$/, "");
}

function setProxy(url) {
  localStorage.setItem(PROXY_KEY, url.replace(/\/+$/, ""));
}

function upstream(path) {
  const base = getProxy();
  if (!base) throw new Error("Proxy URL not set");
  return base + path;
}

async function fetchUpstream(path, init) {
  const res = await fetch(upstream(path), init);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res;
}

// --- map setup ---------------------------------------------------------------

const map = L.map("map", { zoomControl: true }).setView([-34.9285, 138.6007], 12);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const vehicleLayer = L.layerGroup().addTo(map);
const stopLayer = L.layerGroup();
const shapeLayer = L.layerGroup();

// --- protobuf ----------------------------------------------------------------

let FeedMessage = null;

async function loadProto() {
  if (FeedMessage) return FeedMessage;
  const root = await protobuf.load("gtfs-realtime.proto");
  FeedMessage = root.lookupType("transit_realtime.FeedMessage");
  return FeedMessage;
}

async function fetchFeed(path) {
  const [FM, res] = await Promise.all([loadProto(), fetchUpstream(path)]);
  const buf = new Uint8Array(await res.arrayBuffer());
  const msg = FM.decode(buf);
  return FM.toObject(msg, { longs: Number, enums: String, defaults: false });
}

// --- static GTFS -------------------------------------------------------------

const staticCache = {
  version: null,
  files: {},  // filename -> parsed rows
  raw: {},    // filename -> string
};

function parseCsv(text) {
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
      } else { field += ch; }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (ch === "\r") {/* skip */}
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows.shift();
  return rows
    .filter(r => r.length > 1 || (r.length === 1 && r[0] !== ""))
    .map(r => {
      const o = {};
      for (let i = 0; i < header.length; i++) o[header[i]] = r[i];
      return o;
    });
}

async function ensureStatic(onProgress) {
  const versionRes = await fetchUpstream("/v1/static/latest/version.txt");
  const version = (await versionRes.text()).trim();
  if (staticCache.version === version && Object.keys(staticCache.files).length) return staticCache;

  onProgress?.("Downloading static GTFS zip…");
  const zipRes = await fetchUpstream("/v1/static/latest/google_transit.zip");
  const buf = await zipRes.arrayBuffer();

  onProgress?.("Unzipping…");
  const zip = await JSZip.loadAsync(buf);

  staticCache.version = version;
  staticCache.files = {};
  staticCache.raw = {};
  // Only parse the files we actually use, on demand.
  staticCache.zip = zip;

  const routesText = await zip.file("routes.txt")?.async("string");
  if (routesText) {
    staticCache.raw["routes.txt"] = routesText;
    staticCache.files["routes.txt"] = parseCsv(routesText);
  }
  return staticCache;
}

async function getStaticFile(filename) {
  if (staticCache.files[filename]) return staticCache.files[filename];
  const f = staticCache.zip?.file(filename);
  if (!f) return null;
  const text = await f.async("string");
  staticCache.raw[filename] = text;
  staticCache.files[filename] = parseCsv(text);
  return staticCache.files[filename];
}

// --- state -------------------------------------------------------------------

const state = {
  vehicles: [],
  routes: new Map(),          // route_id -> routes.txt row
  stopsLoaded: false,
  shapesFor: null,
  filterRoute: "",
  activeTab: "routes",
  selectedRoute: null,
  markerByVehicle: new Map(),
  activeAbortController: null,
};

function hashColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 80% 60%)`;
}

function routeColor(routeId) {
  if (!routeId) return "#6cb6ff";
  const r = state.routes.get(routeId);
  if (r?.route_color) return `#${r.route_color}`;
  return hashColor(routeId);
}

function routeLabel(routeId) {
  if (!routeId) return "(no route)";
  const r = state.routes.get(routeId);
  if (r?.route_short_name) return r.route_short_name;
  return routeId;
}

// --- rendering ---------------------------------------------------------------

function vehicleIcon(v) {
  const color = routeColor(v.routeId);
  const bearing = typeof v.bearing === "number" ? v.bearing : 0;
  const html = `<div class="vehicle-marker" style="color:${color}">
    <div class="arrow" style="transform: rotate(${bearing}deg);"></div>
  </div>`;
  return L.divIcon({ className: "", html, iconSize: [22, 22] });
}

function vehiclePopup(v) {
  const label = routeLabel(v.routeId);
  const kmh = typeof v.speed === "number" ? (v.speed * 3.6).toFixed(1) : "?";
  const time = v.timestamp ? new Date(v.timestamp * 1000).toLocaleTimeString() : "?";
  return `<div>
    <div><strong>${label}</strong> <span style="color:#8b93a9">(${v.routeId || "?"})</span></div>
    <div>Trip: ${v.tripId || "?"}</div>
    <div>Vehicle: ${v.vehicleLabel || v.vehicleId || v.id}</div>
    <div>Speed: ${kmh} km/h · Bearing: ${v.bearing?.toFixed?.(0) ?? "?"}°</div>
    <div>Reported: ${time}</div>
  </div>`;
}

function renderVehicles() {
  const filter = state.filterRoute.trim().toUpperCase();
  const seen = new Set();
  let visible = 0;
  for (const v of state.vehicles) {
    if (filter && !(v.routeId || "").toUpperCase().includes(filter)) continue;
    visible++;
    seen.add(v.id);
    const existing = state.markerByVehicle.get(v.id);
    if (existing) {
      existing.setLatLng([v.lat, v.lon]);
      existing.setIcon(vehicleIcon(v));
      existing.setPopupContent(vehiclePopup(v));
    } else {
      const m = L.marker([v.lat, v.lon], { icon: vehicleIcon(v) })
        .bindPopup(vehiclePopup(v))
        .addTo(vehicleLayer);
      state.markerByVehicle.set(v.id, m);
    }
  }
  for (const [id, marker] of state.markerByVehicle) {
    if (!seen.has(id)) {
      vehicleLayer.removeLayer(marker);
      state.markerByVehicle.delete(id);
    }
  }
  document.getElementById("stat-vehicles").textContent =
    `${visible}${filter ? ` (of ${state.vehicles.length})` : ""}`;
}

function renderRouteList() {
  const counts = new Map();
  for (const v of state.vehicles) {
    if (!v.routeId) continue;
    counts.set(v.routeId, (counts.get(v.routeId) || 0) + 1);
  }
  const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const ul = document.getElementById("route-list");
  ul.innerHTML = entries.map(([rid, n]) => {
    const r = state.routes.get(rid);
    const name = r?.route_long_name || "";
    const active = state.selectedRoute === rid ? " active" : "";
    const c = routeColor(rid);
    return `<li class="route-item${active}" data-route="${rid}">
      <span class="pill" style="color:${c}; border-color:${c}">${routeLabel(rid)}</span>
      <span>${n} vehicle${n === 1 ? "" : "s"}</span>
      ${name ? `<div class="muted">${name}</div>` : ""}
    </li>`;
  }).join("") || '<li class="muted">No live vehicles.</li>';

  ul.querySelectorAll(".route-item").forEach(li => {
    li.addEventListener("click", () => {
      const rid = li.dataset.route;
      const input = document.getElementById("filter-route");
      if (state.selectedRoute === rid) {
        state.selectedRoute = null;
        state.filterRoute = "";
        input.value = "";
      } else {
        state.selectedRoute = rid;
        state.filterRoute = rid;
        input.value = rid;
      }
      renderVehicles();
      renderRouteList();
      maybeLoadShapes();
    });
  });
}

function fmtDelay(seconds) {
  if (seconds == null) return "on time";
  const s = Math.round(seconds);
  const sign = s > 0 ? "+" : "-";
  const abs = Math.abs(s);
  const mm = Math.floor(abs / 60);
  const ss = abs % 60;
  return `${sign}${mm}m${ss.toString().padStart(2, "0")}s`;
}

function mapTripUpdate(e) {
  const tu = e.tripUpdate;
  const stus = tu.stopTimeUpdate || [];
  const delays = stus
    .map(s => s.arrival?.delay ?? s.departure?.delay)
    .filter(d => typeof d === "number");
  const maxDelay = delays.length
    ? delays.reduce((a, b) => Math.abs(a) > Math.abs(b) ? a : b)
    : null;
  return {
    id: e.id,
    tripId: tu.trip?.tripId,
    routeId: tu.trip?.routeId,
    vehicleLabel: tu.vehicle?.label,
    stopCount: stus.length,
    maxDelay,
  };
}

async function loadUpdates() {
  try {
    const feed = await fetchFeed("/v1/realtime/trip_updates");
    const updates = (feed.entity || []).filter(e => e.tripUpdate).map(mapTripUpdate);
    const sorted = updates
      .filter(u => typeof u.maxDelay === "number")
      .sort((a, b) => Math.abs(b.maxDelay) - Math.abs(a.maxDelay))
      .slice(0, 80);
    const ul = document.getElementById("updates-list");
    ul.innerHTML = sorted.map(u => {
      const cls = u.maxDelay > 0 ? "delay-pos" : "delay-neg";
      const c = routeColor(u.routeId);
      return `<li data-route="${u.routeId || ""}">
        <span class="pill" style="color:${c}; border-color:${c}">${routeLabel(u.routeId)}</span>
        <strong class="${cls}">${fmtDelay(u.maxDelay)}</strong>
        <span class="muted"> · ${u.stopCount} stops</span>
        <div class="muted">Trip ${u.tripId}${u.vehicleLabel ? ` · Vehicle ${u.vehicleLabel}` : ""}</div>
      </li>`;
    }).join("") || '<li class="muted">No trip updates.</li>';

    ul.querySelectorAll("li[data-route]").forEach(li => {
      li.addEventListener("click", () => {
        const rid = li.dataset.route;
        if (!rid) return;
        document.getElementById("filter-route").value = rid;
        state.filterRoute = rid;
        state.selectedRoute = rid;
        renderVehicles();
        renderRouteList();
        maybeLoadShapes();
      });
    });
  } catch (err) { console.warn("updates:", err); }
}

function mapAlert(e) {
  const a = e.alert;
  const txt = (tr) => (tr?.translation?.[0]?.text) || null;
  return {
    id: e.id,
    cause: a.cause,
    effect: a.effect,
    headerText: txt(a.headerText),
    descriptionText: txt(a.descriptionText),
    routes: Array.from(new Set((a.informedEntity || []).map(ie => ie.routeId).filter(Boolean))),
  };
}

async function loadAlerts() {
  try {
    const feed = await fetchFeed("/v1/realtime/service_alerts");
    const alerts = (feed.entity || []).filter(e => e.alert).map(mapAlert);
    const ul = document.getElementById("alerts-list");
    ul.innerHTML = alerts.map(a => {
      const routesHtml = a.routes.slice(0, 6).map(r => `<span class="pill">${routeLabel(r)}</span>`).join(" ");
      return `<li>
        <div><strong>${a.headerText || "(no title)"}</strong></div>
        ${a.descriptionText ? `<div class="muted">${a.descriptionText.slice(0, 240)}${a.descriptionText.length > 240 ? "…" : ""}</div>` : ""}
        <div class="muted">${a.effect || ""}${a.cause ? ` · ${a.cause}` : ""}</div>
        ${routesHtml ? `<div>${routesHtml}</div>` : ""}
      </li>`;
    }).join("") || '<li class="muted">No active alerts.</li>';
  } catch (err) { console.warn("alerts:", err); }
}

async function loadVehicles() {
  const feed = await fetchFeed("/v1/realtime/vehicle_positions");
  state.vehicles = (feed.entity || [])
    .filter(e => e.vehicle?.position)
    .map(e => {
      const v = e.vehicle;
      return {
        id: e.id,
        tripId: v.trip?.tripId,
        routeId: v.trip?.routeId,
        lat: v.position.latitude,
        lon: v.position.longitude,
        bearing: v.position.bearing,
        speed: v.position.speed,
        vehicleId: v.vehicle?.id,
        vehicleLabel: v.vehicle?.label,
        timestamp: v.timestamp,
      };
    });
  document.getElementById("stat-feed-time").textContent = feed.header?.timestamp
    ? new Date(feed.header.timestamp * 1000).toLocaleTimeString()
    : "–";
  renderVehicles();
  renderRouteList();
}

async function loadRoutesIndex() {
  if (state.routes.size) return;
  try {
    await ensureStatic();
    const rows = await getStaticFile("routes.txt");
    state.routes = new Map();
    for (const r of rows || []) state.routes.set(r.route_id, r);
    document.getElementById("stat-version").textContent = staticCache.version || "–";
  } catch (err) { console.warn("routes:", err); }
}

async function loadStops() {
  if (state.stopsLoaded) return;
  await ensureStatic(msg => console.log(msg));
  const rows = await getStaticFile("stops.txt");
  for (const s of rows || []) {
    const lat = parseFloat(s.stop_lat);
    const lon = parseFloat(s.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    L.circleMarker([lat, lon], {
      radius: 3,
      color: "#7fd8a0",
      weight: 1,
      fillOpacity: 0.8,
    }).bindPopup(`<strong>${s.stop_name}</strong><br>ID ${s.stop_id}${s.stop_code ? ` · Code ${s.stop_code}` : ""}`)
      .addTo(stopLayer);
  }
  state.stopsLoaded = true;
}

async function loadShapes(routeId) {
  shapeLayer.clearLayers();
  state.shapesFor = null;
  if (!routeId) return;
  await ensureStatic();
  const trips = await getStaticFile("trips.txt");
  const shapes = await getStaticFile("shapes.txt");
  if (!trips || !shapes) return;

  const shapeIds = new Set(
    trips.filter(t => t.route_id === routeId && t.shape_id).map(t => t.shape_id)
  );
  if (!shapeIds.size) return;

  const grouped = {};
  for (const row of shapes) {
    if (!shapeIds.has(row.shape_id)) continue;
    (grouped[row.shape_id] ??= []).push({
      seq: parseInt(row.shape_pt_sequence, 10),
      lat: parseFloat(row.shape_pt_lat),
      lon: parseFloat(row.shape_pt_lon),
    });
  }
  const color = routeColor(routeId);
  for (const points of Object.values(grouped)) {
    const latlngs = points
      .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      .sort((a, b) => a.seq - b.seq)
      .map(p => [p.lat, p.lon]);
    L.polyline(latlngs, { color, weight: 4, opacity: 0.55 }).addTo(shapeLayer);
  }
  state.shapesFor = routeId;
}

function maybeLoadShapes() {
  if (!document.getElementById("layer-shapes").checked) return;
  const routeId = state.selectedRoute || state.filterRoute.trim();
  if (!routeId) { shapeLayer.clearLayers(); state.shapesFor = null; return; }
  if (routeId === state.shapesFor) return;
  loadShapes(routeId);
}

// --- UI wiring ---------------------------------------------------------------

function showSetup(show) {
  document.getElementById("setup-panel").classList.toggle("hidden", !show);
}

function setStatus(msg, level = "") {
  const el = document.getElementById("proxy-status");
  el.textContent = msg;
  el.className = "hint " + level;
}

async function testProxy(url) {
  setStatus("Testing proxy…");
  const tmp = url.replace(/\/+$/, "");
  const res = await fetch(tmp + "/v1/static/latest/version.txt");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!/^\d+/.test(text.trim())) throw new Error("Unexpected response body");
  return text.trim();
}

document.getElementById("save-proxy").addEventListener("click", async () => {
  const input = document.getElementById("proxy-url");
  const url = input.value.trim();
  if (!url) { setStatus("Please enter a URL.", "err"); return; }
  try {
    const v = await testProxy(url);
    setProxy(url);
    setStatus(`OK. Static feed version: ${v}`, "ok");
    setTimeout(() => { showSetup(false); boot(); }, 600);
  } catch (err) {
    setStatus(`Failed: ${err.message}`, "err");
  }
});

document.getElementById("open-settings").addEventListener("click", () => {
  document.getElementById("proxy-url").value = getProxy();
  showSetup(true);
});

document.getElementById("refresh-now").addEventListener("click", () => refreshAll());
document.getElementById("auto-refresh").addEventListener("change", scheduleRefresh);

document.getElementById("filter-route").addEventListener("input", e => {
  state.filterRoute = e.target.value;
  state.selectedRoute = state.filterRoute.trim() || null;
  renderVehicles();
  renderRouteList();
  maybeLoadShapes();
});

document.getElementById("layer-stops").addEventListener("change", async e => {
  if (e.target.checked) {
    e.target.disabled = true;
    try { await loadStops(); stopLayer.addTo(map); }
    catch (err) { console.warn(err); e.target.checked = false; alert("Failed to load stops: " + err.message); }
    finally { e.target.disabled = false; }
  } else {
    map.removeLayer(stopLayer);
  }
});

document.getElementById("layer-shapes").addEventListener("change", e => {
  if (e.target.checked) {
    shapeLayer.addTo(map);
    maybeLoadShapes();
  } else {
    map.removeLayer(shapeLayer);
  }
});

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.querySelector(`.panel[data-panel="${tab.dataset.tab}"]`).classList.add("active");
    state.activeTab = tab.dataset.tab;
    if (state.activeTab === "updates") loadUpdates();
    if (state.activeTab === "alerts") loadAlerts();
  });
});

// --- refresh loop ------------------------------------------------------------

let timer = null;
function scheduleRefresh() {
  if (timer) clearInterval(timer);
  if (document.getElementById("auto-refresh").checked) {
    timer = setInterval(refreshAll, 15_000);
  }
}

async function refreshAll() {
  if (!getProxy()) return;
  try {
    await loadVehicles();
    if (state.activeTab === "updates") await loadUpdates();
    if (state.activeTab === "alerts") await loadAlerts();
    document.getElementById("stat-refresh").textContent = new Date().toLocaleTimeString();
  } catch (err) {
    console.warn(err);
    document.getElementById("stat-refresh").textContent = "error: " + err.message;
  }
}

// --- boot --------------------------------------------------------------------

async function boot() {
  if (!getProxy()) { showSetup(true); return; }
  showSetup(false);
  // Routes index is nice-to-have; failures shouldn't block live vehicles.
  loadRoutesIndex().catch(() => {});
  await refreshAll();
  loadAlerts();
  scheduleRefresh();
}

boot();
