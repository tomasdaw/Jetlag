/*
 * Geometry engine. Pure functions over GeoJSON (no map, no DOM), so the same
 * code can run on every phone in multiplayer and be tested on its own.
 *
 * Coordinates are GeoJSON order: [lng, lat].
 * The "possible hider region" is a Polygon/MultiPolygon Feature, or null when
 * the answers leave nowhere for the hider to be.
 */
(function () {
  'use strict';
  const turf = window.turf;

  // Local flat projection around an origin. Accurate to well under 1% at city
  // scale, which is all a play area needs.
  const KM_PER_DEG_LAT = 110.574;
  function kmPerDegLng(lat) {
    return 111.320 * Math.cos((lat * Math.PI) / 180);
  }
  function toLocal(p, origin) {
    return [(p[0] - origin[0]) * kmPerDegLng(origin[1]), (p[1] - origin[1]) * KM_PER_DEG_LAT];
  }
  function fromLocal(xy, origin) {
    return [origin[0] + xy[0] / kmPerDegLng(origin[1]), origin[1] + xy[1] / KM_PER_DEG_LAT];
  }

  function intersect(a, b) {
    if (!a || !b) return null;
    try {
      return turf.intersect(turf.featureCollection([a, b]));
    } catch (e) {
      console.warn('intersect failed', e);
      return a;
    }
  }

  function difference(a, b) {
    if (!a) return null;
    if (!b) return a;
    try {
      return turf.difference(turf.featureCollection([a, b]));
    } catch (e) {
      console.warn('difference failed', e);
      return a;
    }
  }

  function circle(center, radiusKm) {
    return turf.circle(center, radiusKm, { steps: 128, units: 'kilometers' });
  }

  // Half-plane of points closer to `target` than to `other`, as a large polygon
  // bounded by the perpendicular bisector of the two points.
  function halfPlaneCloserTo(target, other, sizeKm = 500) {
    const mid = [(target[0] + other[0]) / 2, (target[1] + other[1]) / 2];
    const t = toLocal(target, mid);
    const len = Math.hypot(t[0], t[1]);
    if (len === 0) return null;
    const d = [t[0] / len, t[1] / len];
    const n = [-d[1], d[0]];
    const L = sizeKm;
    const ring = [
      [n[0] * L, n[1] * L],
      [n[0] * L + d[0] * L, n[1] * L + d[1] * L],
      [-n[0] * L + d[0] * L, -n[1] * L + d[1] * L],
      [-n[0] * L, -n[1] * L],
    ].map((xy) => fromLocal(xy, mid));
    ring.push(ring[0]);
    return turf.polygon([ring]);
  }

  function bisectorLine(a, b, halfLengthKm = 80) {
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const v = toLocal(b, mid);
    const len = Math.hypot(v[0], v[1]) || 1;
    const n = [-v[1] / len, v[0] / len];
    return turf.lineString([
      fromLocal([n[0] * halfLengthKm, n[1] * halfLengthKm], mid),
      fromLocal([-n[0] * halfLengthKm, -n[1] * halfLengthKm], mid),
    ]);
  }

  function distanceKm(a, b) {
    return turf.distance(a, b, { units: 'kilometers' });
  }

  /*
   * One handler per question type:
   *   apply(region, params, keep) -> new region
   *   overlay(params)             -> FeatureCollection to draw on the map
   * New question types (rulebook phase) are added here.
   */
  const handlers = {
    radar: {
      apply(region, p, keep) {
        const c = circle(p.center, p.radiusKm);
        if (keep === 'inside') return intersect(region, c);
        if (keep === 'outside') return difference(region, c);
        return region;
      },
      overlay(p) {
        return turf.featureCollection([circle(p.center, p.radiusKm)]);
      },
    },
    thermometer: {
      apply(region, p, keep) {
        if (keep === 'closerToB') return intersect(region, halfPlaneCloserTo(p.b, p.a));
        if (keep === 'closerToA') return intersect(region, halfPlaneCloserTo(p.a, p.b));
        return region;
      },
      overlay(p) {
        return turf.featureCollection([bisectorLine(p.a, p.b), turf.lineString([p.a, p.b])]);
      },
    },
  };

  // Rebuild the region from scratch by replaying every answered question.
  function computeRegion(playArea, log, questionConfig) {
    let region = playArea;
    for (const q of log) {
      if (!q.answer || !region) continue;
      const handler = handlers[q.type];
      const answer = (questionConfig[q.type]?.answers || []).find((a) => a.id === q.answer);
      if (!handler || !answer) continue;
      region = handler.apply(region, q.params, answer.keep);
    }
    return region;
  }

  // Union of circles around each point, then a morphological "closing"
  // (grow by smoothKm, shrink by smoothKm) to round off the scalloped edge and
  // fill small gaps between neighbouring circles.
  function stationBufferArea(points, radiusKm, smoothKm) {
    if (!points.length) return null;
    const circles = points.map((p) => turf.circle(p, radiusKm, { steps: 48, units: 'kilometers' }));
    let area = circles.length === 1 ? circles[0] : turf.union(turf.featureCollection(circles));
    if (area && smoothKm > 0) {
      const grown = turf.buffer(area, smoothKm, { units: 'kilometers', steps: 16 });
      const closed = grown && turf.buffer(grown, -smoothKm, { units: 'kilometers', steps: 16 });
      if (closed) area = closed;
    }
    return area;
  }

  function areaKm2(feature) {
    return feature ? turf.area(feature) / 1e6 : 0;
  }

  window.Geo = {
    handlers,
    computeRegion,
    intersect,
    difference,
    circle,
    halfPlaneCloserTo,
    bisectorLine,
    distanceKm,
    stationBufferArea,
    areaKm2,
  };
})();
