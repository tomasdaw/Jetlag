/*
 * Worldwide city support: find a city (OpenStreetMap Nominatim) and download
 * its métro / light-rail network (OpenStreetMap Overpass), converted to the
 * same GeoJSON shape as data/montreal-transit.geojson:
 *   lines:    { kind: 'line', ref, name, colour, system }  MultiLineString
 *   stations: { kind: 'station', name, system }             Point
 * system is 'metro' (route=subway) or 'light_rail'.
 */
(function () {
  'use strict';
  const CC = window.GAME_CONFIG.citySearch;

  async function searchCities(query) {
    const url = `${CC.nominatimUrl}?format=jsonv2&limit=8&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Search failed (${res.status})`);
    const rows = await res.json();
    const labels = new Set();
    return rows
      .filter((r) => ['place', 'boundary'].includes(r.category))
      .filter((r) => !labels.has(r.display_name) && labels.add(r.display_name)) // same place as city + boundary
      .map((r) => ({
        name: r.name || r.display_name.split(',')[0],
        label: r.display_name,
        center: [+r.lat, +r.lon],
        // Nominatim: [south, north, west, east]
        bbox: [+r.boundingbox[0], +r.boundingbox[2], +r.boundingbox[1], +r.boundingbox[3]], // s, w, n, e
      }));
  }

  // POST a query to the first Overpass server that answers. Each server gets
  // a time limit so a stuck one doesn't hold everything up.
  async function overpass(query, onProgress = () => {}) {
    let lastErr;
    for (const [i, url] of CC.overpassUrls.entries()) {
      if (i > 0) onProgress(`Server busy, trying another (${i + 1}/${CC.overpassUrls.length})…`);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), (CC.serverTimeoutS || 60) * 1000);
      try {
        const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrl.signal });
        if (res.ok) return await res.json();
        lastErr = new Error(`Overpass ${res.status}`);
      } catch (e) {
        lastErr = e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new Error('No Overpass server answered');
  }

  const round = (c) => [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5];
  const FALLBACK_COLOURS = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00897b', '#fdd835', '#6d4c41', '#d81b60', '#3949ab'];

  // "Ligne 8 : Pointe du Lac → Balard" → "Ligne 8"
  const lineName = (tags) => (tags.name ? tags.name.split(/\s*(?::|→|=>|\bvers\b)\s*/)[0].trim() : '') || (tags.ref ? `Line ${tags.ref}` : 'Line');

  /*
   * bbox: [south, west, north, east]. routeTypes: e.g. ['subway', 'light_rail'].
   * onProgress(text) is called with status messages.
   */
  async function loadTransit(bbox, routeTypes, onProgress = () => {}) {
    const [s, w, n, e] = bbox;
    const types = routeTypes.join('|');
    onProgress('Downloading lines and stations from OpenStreetMap…');
    // One request: the route relations, their track (geometry only) and their
    // named stop nodes, which become the stations.
    const data = await overpass(`[out:json][timeout:90];
      relation["route"~"^(${types})$"](${s},${w},${n},${e})->.r;
      .r out body;
      way(r.r);
      out skel geom;
      node(r.r)["name"];
      out;`, onProgress);

    const rels = data.elements.filter((x) => x.type === 'relation');
    const ways = new Map(data.elements.filter((x) => x.type === 'way' && x.geometry).map((x) => [x.id, x]));
    const nodes = new Map(data.elements.filter((x) => x.type === 'node').map((x) => [x.id, x]));
    if (!rels.length) return { type: 'FeatureCollection', features: [] };

    // Group route relations into lines (both directions of a line share ref/name).
    const lines = new Map();
    const usedWays = new Set();
    rels.forEach((r) => {
      const system = r.tags.route === 'subway' ? 'metro' : 'light_rail';
      const key = `${system}|${r.tags.ref || lineName(r.tags)}`;
      if (!lines.has(key)) {
        lines.set(key, {
          ref: key,
          name: lineName(r.tags),
          colour: r.tags.colour || null,
          system,
          coords: [],
        });
      }
      const line = lines.get(key);
      (r.members || []).forEach((m) => {
        if (m.type !== 'way' || usedWays.has(m.ref) || !ways.has(m.ref)) return;
        if (m.role && !['', 'forward', 'backward'].includes(m.role)) return; // skip platforms etc.
        usedWays.add(m.ref);
        line.coords.push(ways.get(m.ref).geometry.map((p) => round([p.lon, p.lat])));
      });
    });

    let colourIdx = 0;
    const features = [];
    lines.forEach((l) => {
      if (!l.coords.length) return;
      let geom = { type: 'MultiLineString', coordinates: l.coords };
      try { geom = turf.simplify({ type: 'Feature', properties: {}, geometry: geom }, { tolerance: 0.00005 }).geometry; } catch (err) { /* keep raw */ }
      features.push({
        type: 'Feature',
        properties: { kind: 'line', ref: l.ref, name: l.name, colour: l.colour || FALLBACK_COLOURS[colourIdx++ % FALLBACK_COLOURS.length], system: l.system },
        geometry: geom,
      });
    });

    // Stations: each route's stop nodes (falling back to platform nodes when a
    // route lists no stops). Stops for both directions and every line at an
    // interchange share a name, so merge same-named stops close together.
    const seen = [];
    rels.forEach((r) => {
      const system = r.tags.route === 'subway' ? 'metro' : 'light_rail';
      const members = (r.members || []).filter((m) => m.type === 'node' && nodes.has(m.ref));
      const stops = members.filter((m) => /^stop/.test(m.role));
      (stops.length ? stops : members.filter((m) => /^platform/.test(m.role))).forEach((m) => {
        const x = nodes.get(m.ref);
        const name = x.tags.name;
        if (seen.some((sx) => sx.name === name && Math.abs(sx.lat - x.lat) < 0.005 && Math.abs(sx.lng - x.lon) < 0.007)) return;
        seen.push({ name, lat: x.lat, lng: x.lon });
        features.push({ type: 'Feature', properties: { kind: 'station', name, system }, geometry: { type: 'Point', coordinates: round([x.lon, x.lat]) } });
      });
    });
    onProgress(`Found ${lines.size} lines and ${seen.length} stations`);

    return { type: 'FeatureCollection', attribution: 'OpenStreetMap contributors (ODbL)', features };
  }

  window.CityData = { searchCities, loadTransit };
})();
