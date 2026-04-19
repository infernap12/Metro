"use strict";

// --- map setup ---------------------------------------------------------------

const map = L.map("map", { zoomControl: true }).setView([-34.9285, 138.6007], 12);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const vehicleLayer = L.layerGroup().addTo(map);
const stopLayer = L.layerGroup();
const shapeLayer = L.layerGroup();

// --- state -------------------------------------------------------------------

const state = {
  vehicles: [],
  routes: new Map(),          // route_id -> route record (from routes.txt)
  stopsLoaded: false,
  shapesFor: null,            // route_id currently rendered
  filterRoute: "",
  activeTab: "routes",
  selectedRoute: null,
  markerByVehicle: new Map(), // vehicle entity id -> marker
};

// Colors per GTFS route_type fallback; hashed per route for variety.
function hashColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 80% 60%)`;
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
  for (const v of state.vehicles) {
    if (filter && !(v.routeId || "").toUpperCase().includes(filter)) continue;
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
  // Remove stale.
  for (const [id, marker] of state.markerByVehicle) {
    if (!seen.has(id)) {
      vehicleLayer.removeLayer(marker);
      state.markerByVehicle.delete(id);
    }
  }
  document.getElementById("stat-vehicles").textContent =
    `${seen.size}${filter ? ` (of ${state.vehicles.length})` : ""}`;
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
    return `<li class="route-item${active}" data-route="${rid}">
      <span class="pill" style="color:${routeColor(rid)}; border-color:${routeColor(rid)}">${routeLabel(rid)}</span>
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
  const sign = s > 0 ? "+" : "";
  const mm = Math.floor(Math.abs(s) / 60);
  const ss = Math.abs(s) % 60;
  return `${sign}${mm}m${ss.toString().padStart(2, "0")}s`;
}

async function loadUpdates() {
  const res = await fetch("/api/trip-updates");
  if (!res.ok) return;
  const data = await res.json();
  const ul = document.getElementById("updates-list");
  const sorted = (data.updates || [])
    .filter(u => typeof u.maxDelay === "number")
    .sort((a, b) => Math.abs(b.maxDelay) - Math.abs(a.maxDelay))
    .slice(0, 80);
  ul.innerHTML = sorted.map(u => {
    const cls = u.maxDelay > 0 ? "delay-pos" : "delay-neg";
    return `<li data-route="${u.routeId || ""}">
      <span class="pill" style="color:${routeColor(u.routeId)}; border-color:${routeColor(u.routeId)}">${routeLabel(u.routeId)}</span>
      <strong class="${cls}">${fmtDelay(u.maxDelay)}</strong>
      <span class="muted"> · ${u.stopCount} stops</span>
      <div class="muted">Trip ${u.tripId}${u.vehicleLabel ? ` · Vehicle ${u.vehicleLabel}` : ""}</div>
    </li>`;
  }).join("") || '<li class="muted">No trip updates.</li>';

  ul.querySelectorAll("li[data-route]").forEach(li => {
    li.addEventListener("click", () => {
      const rid = li.dataset.route;
      if (!rid) return;
      const input = document.getElementById("filter-route");
      input.value = rid;
      state.filterRoute = rid;
      state.selectedRoute = rid;
      renderVehicles();
      renderRouteList();
      maybeLoadShapes();
    });
  });
}

async function loadAlerts() {
  const res = await fetch("/api/alerts");
  if (!res.ok) return;
  const data = await res.json();
  const ul = document.getElementById("alerts-list");
  ul.innerHTML = (data.alerts || []).map(a => {
    const routes = Array.from(new Set((a.informedEntity || []).map(ie => ie.routeId).filter(Boolean)));
    const routesHtml = routes.slice(0, 6).map(r => `<span class="pill">${routeLabel(r)}</span>`).join(" ");
    return `<li>
      <div><strong>${a.headerText || "(no title)"}</strong></div>
      ${a.descriptionText ? `<div class="muted">${a.descriptionText.slice(0, 240)}${a.descriptionText.length > 240 ? "…" : ""}</div>` : ""}
      <div class="muted">${a.effect || ""} ${a.cause ? `· ${a.cause}` : ""}</div>
      ${routesHtml ? `<div>${routesHtml}</div>` : ""}
    </li>`;
  }).join("") || '<li class="muted">No active alerts.</li>';
}

// --- data loading ------------------------------------------------------------

async function loadVehicles() {
  const res = await fetch("/api/vehicles");
  if (!res.ok) return;
  const data = await res.json();
  state.vehicles = data.vehicles || [];
  const t = data.header?.timestamp;
  document.getElementById("stat-feed-time").textContent = t
    ? new Date(t * 1000).toLocaleTimeString()
    : "–";
  renderVehicles();
  renderRouteList();
}

async function loadRoutesStatic() {
  try {
    const res = await fetch("/api/static/routes");
    if (!res.ok) return;
    const data = await res.json();
    state.routes = new Map();
    for (const r of data.routes || []) state.routes.set(r.route_id, r);
    document.getElementById("stat-version").textContent = data.version || "–";
  } catch {}
}

async function loadStops() {
  if (state.stopsLoaded) return;
  const res = await fetch("/api/static/stops");
  if (!res.ok) return;
  const data = await res.json();
  for (const s of data.stops || []) {
    L.circleMarker([s.stop_lat, s.stop_lon], {
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
  const res = await fetch(`/api/static/shapes/${encodeURIComponent(routeId)}`);
  if (!res.ok) return;
  const data = await res.json();
  for (const sh of data.shapes || []) {
    L.polyline(sh.points, {
      color: routeColor(routeId),
      weight: 4,
      opacity: 0.55,
    }).addTo(shapeLayer);
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

// --- wire up UI --------------------------------------------------------------

let timer = null;
function scheduleRefresh() {
  if (timer) clearInterval(timer);
  if (document.getElementById("auto-refresh").checked) {
    timer = setInterval(refreshAll, 15_000);
  }
}

async function refreshAll() {
  await Promise.all([
    loadVehicles(),
    state.activeTab === "updates" ? loadUpdates() : null,
    state.activeTab === "alerts" ? loadAlerts() : null,
  ].filter(Boolean));
  document.getElementById("stat-refresh").textContent = new Date().toLocaleTimeString();
}

document.getElementById("refresh-now").addEventListener("click", refreshAll);
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
    await loadStops();
    stopLayer.addTo(map);
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

// --- boot --------------------------------------------------------------------

(async () => {
  await loadRoutesStatic();
  await refreshAll();
  loadAlerts();
  scheduleRefresh();
})();
