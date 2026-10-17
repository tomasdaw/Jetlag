/*
 * Jet Lag Companion — Phase 1 (single device).
 *
 * State model: the question log is the source of truth. The possible hider
 * region is never stored; it is recomputed from the play area + log, so undo
 * is just "change the log and recompute". Phase 2 will sync this same log.
 */
(function () {
  'use strict';
  const CFG = window.GAME_CONFIG;
  const Geo = window.Geo;
  const QCFG = CFG.questions;
  const STORAGE_KEY = 'jetlag-companion/v1';

  // ---------------------------------------------------------------- state
  function defaultState() {
    return {
      playAreaId: CFG.playArea.defaultPreset,
      customPlayArea: null, // Feature drawn by the players
      units: CFG.defaultUnits,
      gameSize: CFG.defaultGameSize,
      edition: CFG.defaultEdition,
      showOverlays: true,
      showMetro: CFG.map.metro ? CFG.map.metro.showByDefault : false,
      log: [], // [{id, type, params, answer, askedAt, answeredAt}]
      seeker: null, // {lat, lng, source: 'gps'|'manual', accuracy}
    };
  }
  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && Array.isArray(saved.log)) {
        delete saved.deck; // left over from the removed hider-deck feature
        return Object.assign(defaultState(), saved);
      }
    } catch (e) { /* storage unavailable or corrupt: start fresh */ }
    return defaultState();
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  let state = load();
  const enabledTypes = Object.keys(QCFG).filter((t) => QCFG[t].enabled);
  // opt = chosen option id per question type, e.g. { radar: 'r-1', thermometer: 't-3' }
  const draft = { type: enabledTypes[0], opt: {}, customRadius: '', a: null, b: null };
  let mode = null; // null | 'seeker' | 'thermoA' | 'thermoB' | 'draw'
  let drawPoints = [];
  let gpsWatchId = null;
  let playArea = null;
  let region = null;
  let outsideMask = null; // darkened world-minus-play-area, cached per play area
  let activeTab = 'ask';

  // ---------------------------------------------------------------- helpers
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const KM_PER_MI = 1.609344;
  const toKm = (v, unit) => (unit === 'mi' ? v * KM_PER_MI : v);
  function fmtDist(km) {
    const v = state.units === 'mi' ? km / KM_PER_MI : km;
    const u = state.units;
    if (v < 1) return state.units === 'mi' ? `${Math.round(km * 1093.61)} yd` : `${Math.round(km * 1000)} m`;
    return `${+v.toFixed(v < 10 ? 2 : 1)} ${u}`;
  }
  function fmtArea(km2) {
    if (state.units === 'mi') return `${(km2 / 2.58999).toFixed(1)} mi²`;
    return `${km2.toFixed(1)} km²`;
  }
  const lngLat = (p) => [p.lng, p.lat];
  const latLng = (c) => [c[1], c[0]];
  const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const pending = () => state.log.find((q) => !q.answer) || null;

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 2600);
  }

  // In-app confirmation. Native confirm() is unreliable: some browsers and
  // embedded views silently return false, and installed PWAs may block it.
  function confirmDialog(message, okLabel = 'OK') {
    return new Promise((resolve) => {
      const dlg = $('#dialog');
      const ok = $('#dialog-ok');
      const cancel = $('#dialog-cancel');
      $('#dialog-text').textContent = message;
      ok.textContent = okLabel;
      ok.className = 'btn danger-fill';
      dlg.hidden = false;
      ok.focus();
      const done = (result) => {
        dlg.hidden = true;
        ok.onclick = cancel.onclick = dlg.onclick = null;
        resolve(result);
      };
      ok.onclick = () => done(true);
      cancel.onclick = () => done(false);
      dlg.onclick = (e) => { if (e.target === dlg) done(false); };
    });
  }

  // ---------------------------------------------------------------- map
  const map = L.map('map', { zoomControl: false, attributionControl: true }).setView(CFG.map.center, CFG.map.zoom);
  L.tileLayer(CFG.map.tiles.url, { attribution: CFG.map.tiles.attribution, maxZoom: CFG.map.tiles.maxZoom }).addTo(map);

  const layers = {
    excluded: L.layerGroup().addTo(map),
    playArea: L.layerGroup().addTo(map),
    region: L.layerGroup().addTo(map),
    questions: L.layerGroup().addTo(map),
    draft: L.layerGroup().addTo(map),
    seeker: L.layerGroup().addTo(map),
    drawing: L.layerGroup().addTo(map),
  };

  // ---------------------------------------------------------------- metro
  // Own pane above the shading so lines stay readable in ruled-out areas,
  // but below question markers.
  map.createPane('metro').style.zIndex = 450;
  const metroLayer = L.layerGroup();

  async function loadMetro() {
    const mc = CFG.map.metro;
    if (!mc) return;
    const gj = await (await fetch(mc.url)).json();
    const lines = gj.features.filter((f) => f.properties.kind === 'line');
    const stations = gj.features.filter((f) => f.properties.kind === 'station');
    const lineStyle = (f) => mc.lines[f.properties.ref] || { name: `Line ${f.properties.ref}`, colour: f.properties.colour || '#666' };
    L.geoJSON(lines, { pane: 'metro', interactive: false, style: { color: '#fff', weight: 8, opacity: 0.9, lineCap: 'round' } }).addTo(metroLayer);
    L.geoJSON(lines, {
      pane: 'metro',
      style: (f) => ({ color: lineStyle(f).colour, weight: 5, opacity: 1, lineCap: 'round' }),
      onEachFeature: (f, l) => l.bindTooltip(lineStyle(f).name, { sticky: true }),
    }).addTo(metroLayer);
    // Interchange stations (e.g. McGill) exist in both systems; label them once.
    const labelled = new Set();
    stations.forEach((f) => {
      const [lng, lat] = f.geometry.coordinates;
      const outline = (mc.stationStyle && mc.stationStyle[f.properties.system]) || { color: '#1b1b1b' };
      const m = L.circleMarker([lat, lng], { pane: 'metro', radius: 4, color: outline.color, weight: 1.5, fillColor: '#fff', fillOpacity: 1 });
      if (!labelled.has(f.properties.name)) {
        labelled.add(f.properties.name);
        m.bindTooltip(f.properties.name, { permanent: true, direction: 'right', offset: [6, 0], className: 'station-label' });
      }
      m.addTo(metroLayer);
    });
    if (state.showMetro) metroLayer.addTo(map);
    updateStationLabels();
  }

  function updateStationLabels() {
    const mc = CFG.map.metro;
    if (!mc) return;
    const z = map.getZoom();
    map.getContainer().classList.toggle('hide-station-labels', z < mc.stationLabelsFromZoom);
    // Small dots when zoomed out so they don't hide the line colours.
    const r = z <= 11 ? 2 : z <= 13 ? 3.5 : 5;
    metroLayer.eachLayer((l) => l instanceof L.CircleMarker && l.setRadius(r));
  }
  map.on('zoomend', updateStationLabels);

  // Ruled-out / out-of-bounds fill: dark navy diagonal hatch defined in index.html.
  const HATCH_STYLE = { stroke: false, fillColor: 'url(#jl-hatch)', fillOpacity: 0.7 };

  function pointIcon(letter, cls) {
    return L.divIcon({ className: '', html: `<div class="pt-icon ${cls}">${letter}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
  }
  function qLabel(n) {
    return L.divIcon({ className: '', html: `<div class="q-label">Q${n}</div>`, iconSize: null });
  }

  function drawQuestionOverlay(group, q, n, style) {
    const p = q.params;
    if (q.type === 'radar') {
      L.geoJSON(Geo.handlers.radar.overlay(p), { style, interactive: false }).addTo(group);
      L.circleMarker(latLng(p.center), { radius: 4, color: style.color, fillOpacity: 1, weight: 1 }).addTo(group);
      if (n) L.marker(latLng(Geo.circle(p.center, p.radiusKm).geometry.coordinates[0][0]), { icon: qLabel(n), interactive: false }).addTo(group);
    } else if (q.type === 'thermometer') {
      const fc = Geo.handlers.thermometer.overlay(p);
      L.geoJSON(fc.features[0], { style, interactive: false }).addTo(group);
      L.geoJSON(fc.features[1], { style: { color: style.color, weight: 2, dashArray: '2 6' }, interactive: false }).addTo(group);
      L.marker(latLng(p.a), { icon: pointIcon('A', 'a'), interactive: false }).addTo(group);
      L.marker(latLng(p.b), { icon: pointIcon('B', 'b'), interactive: false }).addTo(group);
      if (n) L.marker(latLng([(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2]), { icon: qLabel(n), interactive: false }).addTo(group);
    }
  }

  function renderMap() {
    Object.values(layers).forEach((g) => g.clearLayers());
    if (!playArea) return;

    if (!outsideMask || outsideMask.source !== playArea) {
      outsideMask = { source: playArea, shape: Geo.difference(turf.bboxPolygon([-180, -85, 180, 85]), playArea) };
    }
    if (outsideMask.shape) {
      L.geoJSON(outsideMask.shape, { style: HATCH_STYLE, interactive: false }).addTo(layers.playArea);
    }
    L.geoJSON(playArea, { style: { color: '#0f1b2d', weight: 1.5, opacity: 0.5, dashArray: '6 6', fill: false }, interactive: false }).addTo(layers.playArea);

    const excluded = region ? Geo.difference(playArea, region) : playArea;
    if (excluded) {
      L.geoJSON(excluded, { style: HATCH_STYLE, interactive: false }).addTo(layers.excluded);
    }
    if (region) {
      L.geoJSON(region, { style: { color: '#ffb020', weight: 1.5, opacity: 0.45, fill: false }, interactive: false }).addTo(layers.region);
    }

    if (state.showOverlays) {
      state.log.forEach((q, i) => {
        const isPending = !q.answer;
        drawQuestionOverlay(layers.questions, q, i + 1, {
          color: isPending ? '#ffb020' : '#2f8cff', weight: isPending ? 3 : 2, fill: false,
          dashArray: isPending ? '8 6' : null, opacity: isPending ? 1 : 0.7,
        });
      });
    }

    renderDraftOverlay();
    renderSeeker();
    renderDrawing();
  }

  function renderDraftOverlay() {
    layers.draft.clearLayers();
    if (pending()) return;
    const style = { color: '#ffb020', weight: 2, dashArray: '4 6', fill: true, fillOpacity: 0.06 };
    if (draft.type === 'radar') {
      const r = currentRadiusKm();
      if (state.seeker && r) drawQuestionOverlay(layers.draft, { type: 'radar', params: { center: lngLat(state.seeker), radiusKm: r } }, 0, style);
    } else if (draft.type === 'thermometer') {
      if (draft.a) L.marker([draft.a.lat, draft.a.lng], { icon: pointIcon('A', 'a'), interactive: false }).addTo(layers.draft);
      if (draft.b) L.marker([draft.b.lat, draft.b.lng], { icon: pointIcon('B', 'b'), interactive: false }).addTo(layers.draft);
      if (draft.a && draft.b && (draft.a.lat !== draft.b.lat || draft.a.lng !== draft.b.lng)) {
        drawQuestionOverlay(layers.draft, { type: 'thermometer', params: { a: lngLat(draft.a), b: lngLat(draft.b) } }, 0, style);
      }
    }
  }

  function renderSeeker() {
    layers.seeker.clearLayers();
    const s = state.seeker;
    if (!s) return;
    if (s.source === 'gps' && s.accuracy) {
      L.circle([s.lat, s.lng], { radius: s.accuracy, color: '#2f8cff', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(layers.seeker);
    }
    L.circleMarker([s.lat, s.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#2f8cff', fillOpacity: 1, interactive: false })
      .addTo(layers.seeker);
  }

  function renderDrawing() {
    layers.drawing.clearLayers();
    if (mode !== 'draw' || !drawPoints.length) return;
    const pts = drawPoints.map((p) => [p.lat, p.lng]);
    L.polyline(pts.length > 2 ? pts.concat([pts[0]]) : pts, { color: '#ffb020', weight: 3, dashArray: '4 4' }).addTo(layers.drawing);
    pts.forEach((p) => L.circleMarker(p, { radius: 5, color: '#ffb020', fillOpacity: 1 }).addTo(layers.drawing));
  }

  function renderStat() {
    const el = $('#area-stat');
    if (!playArea) { el.textContent = 'Loading…'; return; }
    if (!region) {
      el.className = 'stat empty';
      el.innerHTML = '<b>No possible area</b> — check answers';
      return;
    }
    const total = Geo.areaKm2(playArea);
    const left = Geo.areaKm2(region);
    el.className = 'stat';
    el.innerHTML = `<b>${fmtArea(left)}</b> left · ${Math.round((left / total) * 100)}%`;
  }

  function recompute() {
    region = playArea ? Geo.computeRegion(playArea, state.log, QCFG) : null;
    renderMap();
    renderStat();
  }

  function fitRegion() {
    const target = region || playArea;
    map.invalidateSize();
    if (!target) return;
    // Keep the area clear of the panel (left on wide screens, bottom on phones).
    const wide = window.innerWidth >= 820;
    const sheetH = $('#sheet').getBoundingClientRect().height;
    map.fitBounds(L.geoJSON(target).getBounds(), {
      paddingTopLeft: [wide ? 410 : 20, 70],
      paddingBottomRight: [wide ? 70 : 20, wide ? 20 : sheetH + 10],
    });
  }

  // ---------------------------------------------------------------- play area
  async function loadPlayArea() {
    if (state.playAreaId === 'custom' && state.customPlayArea) {
      playArea = state.customPlayArea;
    } else {
      const id = CFG.playArea.presets[state.playAreaId] ? state.playAreaId : CFG.playArea.defaultPreset;
      if (!presetCache[id]) presetCache[id] = await buildPreset(CFG.playArea.presets[id]);
      playArea = presetCache[id];
    }
    recompute();
  }

  const presetCache = {};
  async function buildPreset(preset) {
    if (preset.type === 'station-buffer') {
      const gj = await (await fetch(preset.source)).json();
      const extra = preset.includeStations || {};
      const stations = gj.features.filter((f) => f.properties.kind === 'station');
      const points = stations
        .filter((f) => (preset.includeSystems || []).includes(f.properties.system) || (extra[f.properties.system] || []).includes(f.properties.name))
        .map((f) => f.geometry.coordinates);
      const routes = (preset.includeRoutes || []).map((r) => r.stations.map((name) => {
        const f = stations.find((s) => s.properties.system === r.system && s.properties.name === name);
        if (!f) console.warn(`Play area: station "${name}" not found`);
        return f && f.geometry.coordinates;
      }).filter(Boolean));
      routes.forEach((r) => points.push(...r));
      const shape = Geo.stationBufferArea(points, preset.radiusM / 1000, (preset.smoothM || 0) / 1000, routes);
      return { type: 'Feature', properties: { name: preset.label, stations: points.length }, geometry: shape.geometry };
    }
    const gj = await (await fetch(preset.url)).json();
    const f = gj.type === 'FeatureCollection' ? gj.features[0] : gj.type === 'Feature' ? gj : { type: 'Feature', properties: {}, geometry: gj };
    return { type: 'Feature', properties: { name: preset.label }, geometry: f.geometry };
  }

  // ---------------------------------------------------------------- seeker location
  function setSeeker(p, source, accuracy) {
    state.seeker = { lat: p.lat, lng: p.lng, source, accuracy: accuracy || null };
    save();
    renderSeeker();
    renderDraftOverlay();
    if (activeTab === 'ask') renderAsk();
  }

  function startGps() {
    if (!('geolocation' in navigator)) { toast('This browser has no GPS access. Place your position on the map instead.'); return; }
    let first = true;
    gpsWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        setSeeker({ lat: pos.coords.latitude, lng: pos.coords.longitude }, 'gps', pos.coords.accuracy);
        if (first) { map.setView([pos.coords.latitude, pos.coords.longitude], Math.max(map.getZoom(), 14)); first = false; }
      },
      (err) => {
        toast(err.code === 1 ? 'Location permission denied. Place your position on the map instead.' : 'Could not get GPS: ' + err.message);
        stopGps();
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
    $('#btn-gps').classList.add('on');
    toast('Following GPS');
  }
  function stopGps() {
    if (gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
    $('#btn-gps').classList.remove('on');
  }

  // ---------------------------------------------------------------- tap-the-map modes
  const MODE_TEXT = {
    seeker: 'Tap the map where the seekers are',
    thermoA: 'Tap the map to set point A (start)',
    thermoB: 'Tap the map to set point B (end)',
    draw: 'Tap to add play-area corners',
  };
  function enterMode(m) {
    mode = m;
    if (m === 'draw') drawPoints = [];
    renderBanner();
    if (window.innerWidth < 820) $('#sheet').classList.add('collapsed');
  }
  function exitMode() {
    mode = null;
    drawPoints = [];
    renderBanner();
    renderDrawing();
    $('#sheet').classList.remove('collapsed');
  }
  function renderBanner() {
    const b = $('#mode-banner');
    if (!mode) { b.hidden = true; return; }
    b.hidden = false;
    $('#mode-text').textContent = mode === 'draw' ? `${MODE_TEXT.draw} (${drawPoints.length})` : MODE_TEXT[mode];
    $('#mode-actions').innerHTML = mode === 'draw'
      ? `<button data-mode="undo-pt" ${drawPoints.length ? '' : 'disabled'}>Undo</button>
         <button data-mode="finish" ${drawPoints.length >= 3 ? '' : 'disabled'}>Finish</button>
         <button data-mode="cancel">Cancel</button>`
      : '<button data-mode="cancel">Cancel</button>';
  }

  map.on('click', (e) => {
    const p = { lat: e.latlng.lat, lng: e.latlng.lng };
    if (mode === 'seeker') {
      stopGps();
      setSeeker(p, 'manual');
      exitMode();
    } else if (mode === 'thermoA') {
      draft.a = p; exitMode(); renderAsk(); renderDraftOverlay();
    } else if (mode === 'thermoB') {
      draft.b = p; exitMode(); renderAsk(); renderDraftOverlay();
    } else if (mode === 'draw') {
      drawPoints.push(p); renderBanner(); renderDrawing();
    }
  });

  $('#mode-actions').addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.mode;
    if (act === 'cancel') exitMode();
    if (act === 'undo-pt') { drawPoints.pop(); renderBanner(); renderDrawing(); }
    if (act === 'finish') {
      const ring = drawPoints.map((p) => [p.lng, p.lat]);
      ring.push(ring[0]);
      state.customPlayArea = { type: 'Feature', properties: { name: 'Custom area' }, geometry: { type: 'Polygon', coordinates: [ring] } };
      state.playAreaId = 'custom';
      save();
      exitMode();
      loadPlayArea().then(fitRegion);
      renderSetup();
      toast('Custom play area set');
    }
  });

  // ---------------------------------------------------------------- questions
  // ---- options (the individual questions inside a category)
  // Each question type has a set of options per rulebook edition (metric/imperial).
  const editionOf = (type) => QCFG[type].editions[state.edition] || Object.values(QCFG[type].editions)[0];
  function optionsFor(type) {
    return editionOf(type).options.filter((o) => !o.sizes || o.sizes.includes(state.gameSize));
  }
  // Searches every edition, so questions logged before an edition switch still resolve.
  function findOption(type, id) {
    for (const [ed, e] of Object.entries(QCFG[type].editions)) {
      const o = e.options.find((x) => x.id === id);
      if (o) return Object.assign({ unit: e.unit, edition: ed }, o);
    }
    return null;
  }
  const selectedOption = (type) => findOption(type, draft.opt[type]);
  const optionKm = (type, o) => toKm(o.value, o.unit || editionOf(type).unit);

  // How many times an option has been asked before (withdrawn questions are
  // removed from the log, so they don't count).
  function timesAsked(type, optId, beforeIndex = state.log.length) {
    return state.log.slice(0, beforeIndex).filter((q) => q.type === type && q.params.optionId === optId).length;
  }
  // Repeat number for a logged question: 1 for the first time, 2 for the second, …
  const repeatOf = (q) => timesAsked(q.type, q.params.optionId, state.log.indexOf(q)) + 1;
  const optionBlocked = (type, optId) => CFG.allowRepeatQuestions === false && timesAsked(type, optId) > 0;

  function costText(type, multiplier) {
    const c = QCFG[type].cost;
    if (!c) return '';
    const base = `draw ${c.draw}, keep ${c.keep}`;
    if (multiplier <= 1) return `Hider: ${base}`;
    return `Hider: ${base}, ${multiplier === 2 ? 'twice' : `${multiplier} times`} (repeat ×${multiplier})`;
  }

  function currentRadiusKm() {
    const o = selectedOption('radar');
    if (!o) return null;
    if (o.custom) {
      const v = parseFloat(draft.customRadius);
      return v > 0 ? toKm(v, state.units) : null;
    }
    return optionKm('radar', o);
  }
  function canAskRadar() {
    const o = selectedOption('radar');
    return !!(o && state.seeker && currentRadiusKm() && !optionBlocked('radar', o.id));
  }

  // Thermometer: the seekers must travel at least the chosen distance from A.
  function thermoStatus() {
    const o = selectedOption('thermometer');
    const required = o ? optionKm('thermometer', o) : null;
    const d = draft.a && draft.b ? Geo.distanceKm(lngLat(draft.a), lngLat(draft.b)) : null;
    return { o, required, d, ok: !!(o && d != null && d >= required && !optionBlocked('thermometer', o.id)) };
  }

  const optionLabel = (q) => findOption(q.type, q.params.optionId)?.label || null;

  function describe(q) {
    const label = optionLabel(q);
    if (q.type === 'radar') {
      const r = fmtDist(q.params.radiusKm);
      if (!label || findOption('radar', q.params.optionId)?.custom) return `Chosen: ${r}`;
      return label === r ? label : `${label} (${r})`;
    }
    if (q.type === 'thermometer') return `${label ? label + ': ' : ''}A → B ${fmtDist(Geo.distanceKm(q.params.a, q.params.b))}`;
    return q.type;
  }

  function promptFor(q) {
    const c = QCFG[q.type];
    if (q.type === 'radar') {
      const o = findOption('radar', q.params.optionId);
      const d = fmtDist(q.params.radiusKm);
      const r = o && !o.custom && o.label !== d ? `${o.label} (${d})` : d;
      return c.prompt.replace('{radius}', r);
    }
    if (q.type === 'thermometer') {
      return c.prompt.replace('{option}', optionLabel(q) || '').replace('{distance}', fmtDist(Geo.distanceKm(q.params.a, q.params.b)));
    }
    return c.prompt || c.label;
  }

  function askQuestion() {
    let params;
    if (draft.type === 'radar') {
      const o = selectedOption('radar');
      const r = currentRadiusKm();
      if (!o || !state.seeker || !r) return;
      if (optionBlocked('radar', o.id)) { toast(`${o.label} radar has already been asked`); return; }
      params = { optionId: o.id, center: lngLat(state.seeker), radiusKm: r, centerSource: state.seeker.source };
    } else if (draft.type === 'thermometer') {
      const t = thermoStatus();
      if (!t.o || t.d == null) return;
      if (!t.ok) { toast(`Travel at least ${t.o.label} (${fmtDist(t.required)}) from A first`); return; }
      params = { optionId: t.o.id, a: lngLat(draft.a), b: lngLat(draft.b) };
    }
    state.log.push({ id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), type: draft.type, params, answer: null, askedAt: Date.now(), answeredAt: null });
    if (draft.type === 'thermometer') { draft.a = null; draft.b = null; }
    save();
    recompute();
    renderAll();
    toast('Question asked — hider, tap your answer');
  }

  function answerPending(answerId) {
    const q = pending();
    if (!q) return;
    q.answer = answerId;
    q.answeredAt = Date.now();
    // Deselect the option just used so a repeat (at higher cost) is a deliberate choice.
    draft.opt[q.type] = null;
    if (q.type === 'radar') draft.customRadius = '';
    save();
    recompute();
    renderAll();
    toast(region ? 'Map updated' : 'Warning: no possible area left. Check the answers.');
  }

  // Undo acts on the newest log entry only: an answer is retracted (the
  // question goes back to waiting), a waiting question is withdrawn.
  async function undoLast() {
    const last = state.log[state.log.length - 1];
    if (!last) return;
    if (last.answer) {
      if (!(await confirmDialog(`Retract the answer to Q${state.log.length}?`, 'Retract'))) return;
      last.answer = null;
      last.answeredAt = null;
      toast('Answer retracted');
    } else {
      if (!(await confirmDialog(`Withdraw Q${state.log.length} (not answered yet)?`, 'Withdraw'))) return;
      state.log.pop();
      toast('Question withdrawn');
    }
    save();
    recompute();
    renderAll();
  }

  // ---------------------------------------------------------------- panel rendering
  function seekerStatus() {
    const s = state.seeker;
    if (!s) return '<span class="val">Not set</span>';
    if (s.source === 'gps') return `<span class="val set">GPS${s.accuracy ? ` ±${Math.round(s.accuracy)} m` : ''}</span>`;
    return '<span class="val set">Placed on map</span>';
  }
  function pointStatus(p) {
    return p ? `<span class="val set">${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}</span>` : '<span class="val">Not set</span>';
  }

  function renderAsk() {
    const el = $('#tab-ask');
    const q = pending();
    if (q) {
      const n = state.log.indexOf(q) + 1;
      el.innerHTML = `
        <div class="pending">
          <div class="kicker">Q${n} · ${esc(QCFG[q.type].label)} · waiting for the hider</div>
          <div class="prompt">${esc(promptFor(q))}</div>
          ${QCFG[q.type].cost ? `<p class="cost">${esc(costText(q.type, repeatOf(q)))} after answering</p>` : ''}
          <div class="answers">
            ${QCFG[q.type].answers.map((a) => `<button class="btn" data-act="answer" data-answer="${esc(a.id)}">${esc(a.label)}</button>`).join('')}
          </div>
          <button class="btn small danger" style="margin-top:12px" data-act="undo">Withdraw question</button>
        </div>
        <p class="muted">The hider reads the question and taps the answer. Nothing about the hider's location is collected.</p>`;
      return;
    }

    const typeSeg = `<div class="seg">${enabledTypes.map((t) => `<button data-act="type" data-type="${t}" class="${draft.type === t ? 'active' : ''}">${esc(QCFG[t].label)}</button>`).join('')}</div>
      <p class="muted">${esc(QCFG[draft.type].description)}</p>`;

    const sel = selectedOption(draft.type);
    const repeatNote = sel && timesAsked(draft.type, sel.id) > 0 && !optionBlocked(draft.type, sel.id)
      ? `<p class="cost warn">Asked before: this repeat costs ×${timesAsked(draft.type, sel.id) + 1}. ${esc(costText(draft.type, timesAsked(draft.type, sel.id) + 1))}.</p>`
      : sel && QCFG[draft.type].cost ? `<p class="cost">${esc(costText(draft.type, 1))}.</p>` : '';

    let body = '';
    if (draft.type === 'radar') {
      const custom = sel && sel.custom;
      body = `
        <h3>Seeker position (circle center)</h3>
        <div class="point"><div><div class="label">Seekers</div>${seekerStatus()}</div>
          <div class="row"><button class="btn small" data-act="gps">Use GPS</button><button class="btn small" data-act="tap-seeker">Tap map</button></div></div>
        <h3>Radius</h3>
        ${optionChips('radar')}
        ${custom ? `<div class="row" style="margin-top:8px"><input id="custom-radius" type="number" min="0" step="0.1" inputmode="decimal" value="${esc(draft.customRadius)}" placeholder="Any distance"> <span>${state.units}</span></div>` : ''}
        ${repeatNote}
        <button class="btn primary block" data-act="ask" ${canAskRadar() ? '' : 'disabled'}>Ask radar question</button>`;
    } else if (draft.type === 'thermometer') {
      const t = thermoStatus();
      const d = t.d;
      const progress = t.o && d != null
        ? `<p class="muted">Travelled <b>${fmtDist(d)}</b> of ${esc(t.o.label)}${t.o.label === fmtDist(t.required) ? '' : ` (${fmtDist(t.required)})`} ${d >= t.required ? '<span class="ok">✓ far enough</span>' : '<span class="warn-text">— keep going</span>'}</p>`
        : '';
      body = `
        <h3>Distance to travel</h3>
        ${optionChips('thermometer')}
        ${repeatNote}
        <h3>Where the seekers travelled</h3>
        <div class="point"><div><div class="label"><span class="badge a">A</span>Start</div>${pointStatus(draft.a)}</div>
          <div class="row"><button class="btn small" data-act="a-here" ${state.seeker ? '' : 'disabled'}>My position</button><button class="btn small" data-act="tap-a">Tap map</button></div></div>
        <div class="point"><div><div class="label"><span class="badge b">B</span>End</div>${pointStatus(draft.b)}</div>
          <div class="row"><button class="btn small" data-act="b-here" ${state.seeker ? '' : 'disabled'}>My position</button><button class="btn small" data-act="tap-b">Tap map</button></div></div>
        ${progress || (t.o ? '<p class="muted">Set A when you start moving, then B once you have travelled far enough.</p>' : '<p class="muted">Pick a distance first.</p>')}
        <button class="btn primary block" data-act="ask" ${t.ok ? '' : 'disabled'}>Ask thermometer question</button>`;
    }
    el.innerHTML = typeSeg + body;
  }

  // Option buttons for a category. Asked options show how many times; a repeat
  // stays available (at higher cost) unless repeats are turned off in config.
  function optionChips(type) {
    const u = editionOf(type).unit;
    return `<div class="chips">${optionsFor(type).map((o) => {
      const n = timesAsked(type, o.id);
      const blocked = optionBlocked(type, o.id);
      const hint = o.custom ? '' : (state.units !== u ? `<small>${fmtDist(optionKm(type, o))}</small>` : '');
      return `<button class="chip ${draft.opt[type] === o.id ? 'active' : ''} ${n ? 'asked' : ''}" data-act="option" data-type="${type}" data-opt="${esc(o.id)}"
        ${blocked ? 'disabled' : ''} title="${n ? `Asked ${n}× — next costs ×${n + 1}` : ''}">${esc(o.label)}${hint}${n ? `<span class="rep">✓${n > 1 ? n : ''}</span>` : ''}</button>`;
    }).join('')}</div>`;
  }

  function renderLog() {
    const el = $('#tab-log');
    $('#log-count').textContent = state.log.length || '';
    if (!state.log.length) {
      el.innerHTML = '<p class="muted">No questions yet. Ask one from the Ask tab.</p>';
      return;
    }
    const last = state.log[state.log.length - 1];
    const items = state.log.map((q, i) => {
      const ans = q.answer ? QCFG[q.type].answers.find((a) => a.id === q.answer) : null;
      const rep = q.params.optionId ? repeatOf(q) : 1;
      return `<li>
        <div class="num">${i + 1}</div>
        <div><div class="title">${esc(QCFG[q.type]?.label || q.type)}${rep > 1 ? ` <span class="rep">repeat ×${rep}</span>` : ''}</div><div class="sub">${esc(describe(q))} · ${fmtTime(q.askedAt)}</div></div>
        <span class="ans ${ans ? 'done' : 'waiting'}">${ans ? esc(ans.label) : 'Waiting'}</span>
      </li>`;
    }).reverse().join('');
    el.innerHTML = `
      <button class="btn danger block" style="margin-top:0" data-act="undo">${last.answer ? `Retract answer to Q${state.log.length}` : `Withdraw Q${state.log.length}`}</button>
      <ul class="log">${items}</ul>`;
  }

  function renderSetup() {
    const presets = Object.entries(CFG.playArea.presets).map(([id, p]) =>
      `<label class="radio"><input type="radio" name="pa" value="${esc(id)}" ${state.playAreaId === id ? 'checked' : ''}> ${esc(p.label)}</label>`).join('');
    $('#tab-setup').innerHTML = `
      <h3>Play area</h3>
      ${presets}
      ${state.customPlayArea ? `<div class="radio">
        <label><input type="radio" name="pa" value="custom" ${state.playAreaId === 'custom' ? 'checked' : ''}> Custom area (drawn)</label>
        <button class="btn small danger" data-act="delete-custom" aria-label="Delete custom play area">Delete</button>
      </div>` : ''}
      <button class="btn small" data-act="draw">Draw a custom play area</button>

      <h3>Rulebook edition</h3>
      <div class="seg">
        ${Object.entries(CFG.editions).map(([id, e]) => `<button data-act="edition" data-edition="${id}" class="${state.edition === id ? 'active' : ''}">${esc(e.label)}</button>`).join('')}
      </div>
      <p class="muted">Pick the one that matches your box. It sets the radar and thermometer distances.</p>

      <h3>Game size</h3>
      <div class="seg">
        ${Object.entries(CFG.gameSizes).map(([id, s]) => `<button data-act="size" data-size="${id}" class="${state.gameSize === id ? 'active' : ''}">${esc(s.label)}</button>`).join('')}
      </div>
      <p class="muted">${esc(CFG.gameSizes[state.gameSize]?.description || '')}. Decides which questions are available.</p>

      <h3>Units</h3>
      <div class="seg">
        <button data-act="units" data-units="km" class="${state.units === 'km' ? 'active' : ''}">Kilometres</button>
        <button data-act="units" data-units="mi" class="${state.units === 'mi' ? 'active' : ''}">Miles</button>
      </div>

      <h3>Map</h3>
      <label class="radio"><input type="checkbox" id="show-overlays" ${state.showOverlays ? 'checked' : ''}> Show question circles and lines</label>
      ${CFG.map.metro ? `<label class="radio"><input type="checkbox" id="show-metro" ${state.showMetro ? 'checked' : ''}> Show métro and REM lines and stations</label>` : ''}

      <h3>Rules</h3>
      <div class="note">${esc(CFG.meta.rulesStatus)} <br>Version: <code>${esc(CFG.meta.rulesVersion)}</code></div>

      <h3>Location</h3>
      <div class="note">Only the seekers' position is used. GPS can pause when the phone is locked or the browser is in the background; use “Tap map” to place your position by hand.</div>

      <h3>Game</h3>
      <button class="btn danger" data-act="reset">Reset game (clear all questions)</button>`;
  }

  function renderAll() {
    renderAsk();
    renderLog();
    renderSetup();
  }

  // ---------------------------------------------------------------- events
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    const sheet = $('#sheet');
    // On phones, tapping the open tab again folds the panel down.
    if (b.dataset.tab === activeTab && !sheet.classList.contains('collapsed') && window.innerWidth < 820) {
      sheet.classList.add('collapsed');
      return;
    }
    activeTab = b.dataset.tab;
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    ['ask', 'log', 'setup'].forEach((t) => ($('#tab-' + t).hidden = t !== activeTab));
    sheet.classList.remove('collapsed');
  });

  $('#sheet').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    switch (act) {
      case 'type': draft.type = b.dataset.type; renderAsk(); renderDraftOverlay(); break;
      case 'option':
        draft.opt[b.dataset.type] = b.dataset.opt;
        renderAsk();
        renderDraftOverlay();
        if (selectedOption('radar')?.custom && b.dataset.type === 'radar') $('#custom-radius')?.focus();
        break;
      case 'size': state.gameSize = b.dataset.size; save(); renderAll(); break;
      case 'edition':
        state.edition = b.dataset.edition;
        state.units = CFG.editions[state.edition].units; // show distances the way the book does
        draft.opt = {};
        save();
        renderAll();
        renderStat();
        break;
      case 'gps': if (gpsWatchId === null) startGps(); else toast('Already following GPS'); break;
      case 'tap-seeker': enterMode('seeker'); break;
      case 'tap-a': enterMode('thermoA'); break;
      case 'tap-b': enterMode('thermoB'); break;
      case 'a-here': draft.a = { lat: state.seeker.lat, lng: state.seeker.lng }; renderAsk(); renderDraftOverlay(); break;
      case 'b-here': draft.b = { lat: state.seeker.lat, lng: state.seeker.lng }; renderAsk(); renderDraftOverlay(); break;
      case 'ask': askQuestion(); break;
      case 'answer': answerPending(b.dataset.answer); break;
      case 'undo': undoLast(); break;
      case 'draw': enterMode('draw'); break;
      case 'delete-custom': {
        const inUse = state.playAreaId === 'custom';
        confirmDialog(inUse ? 'Delete the custom play area? The game will switch back to the default area.' : 'Delete the custom play area?', 'Delete')
          .then((ok) => {
            if (!ok) return;
            state.customPlayArea = null;
            if (inUse) state.playAreaId = CFG.playArea.defaultPreset;
            save();
            renderSetup();
            if (inUse) loadPlayArea().then(fitRegion);
            toast('Custom play area deleted');
          });
        break;
      }
      case 'units': state.units = b.dataset.units; save(); renderAll(); renderStat(); break;
      case 'reset':
        confirmDialog('Clear every question and start a new game?', 'Reset').then((ok) => {
          if (!ok) return;
          state.log = [];
          save();
          recompute();
          renderAll();
          toast('New game');
        });
        break;
    }
  });

  $('#sheet').addEventListener('input', (e) => {
    if (e.target.id === 'custom-radius') {
      draft.customRadius = e.target.value;
      const btn = document.querySelector('#tab-ask [data-act="ask"]');
      if (btn) btn.disabled = !canAskRadar();
      renderDraftOverlay();
    }
  });

  $('#sheet').addEventListener('change', (e) => {
    if (e.target.name === 'pa') {
      state.playAreaId = e.target.value;
      save();
      loadPlayArea().then(fitRegion);
    } else if (e.target.id === 'show-overlays') {
      state.showOverlays = e.target.checked;
      save();
      renderMap();
    } else if (e.target.id === 'show-metro') {
      state.showMetro = e.target.checked;
      save();
      if (state.showMetro) metroLayer.addTo(map); else metroLayer.remove();
    }
  });

  $('#sheet-handle').addEventListener('click', () => $('#sheet').classList.toggle('collapsed'));
  $('#btn-gps').addEventListener('click', () => (gpsWatchId === null ? startGps() : (stopGps(), toast('Stopped following GPS'))));
  $('#btn-place').addEventListener('click', () => enterMode('seeker'));
  $('#btn-fit').addEventListener('click', fitRegion);

  // ---------------------------------------------------------------- start
  renderAll();
  // Phones start with the panel folded so the map gets the screen.
  if (window.innerWidth < 820) $('#sheet').classList.add('collapsed');
  loadPlayArea().then(fitRegion).catch((err) => {
    console.error(err);
    toast('Could not load the play area');
  });
  loadMetro().catch((err) => console.warn('Could not load métro data', err));

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }

  // Exposed for debugging in the console.
  window.JLC = { map, get state() { return state; }, get region() { return region; }, recompute, renderAll, save };
})();
