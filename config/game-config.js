/*
 * Game configuration — the ONLY place game rules live.
 *
 * The game ships in two editions with different distances:
 *   metric   — from photos of the printed rulebook (radar p.28–30, thermometer p.30–31,
 *              hiding zones p.5)
 *   imperial — from the fan-made recreation at https://www.lifack.ch/docs/
 * Check against your own rulebook when the box arrives.
 */
window.GAME_CONFIG = {
  meta: {
    rulesVersion: 'rulebook-2026-10',
    rulesStatus: 'Radar and thermometer follow the rulebook (metric edition from the printed book, imperial from lifack.ch). Other question categories, cards and curses are not in the app yet.',
  },

  editions: {
    metric: { label: 'Metric (km)', units: 'km' },
    imperial: { label: 'Imperial (mi)', units: 'mi' },
  },
  defaultEdition: 'metric',

  // Game size decides which questions are available (rulebook: Choosing Game Size).
  gameSizes: {
    small: { label: 'Small', description: 'Part of a large city, 4–8 hours' },
    medium: { label: 'Medium', description: 'A whole major city, about 1 day' },
    large: { label: 'Large', description: 'A region or country, 2–4 days' },
  },
  defaultGameSize: 'small',

  // Asking the same question again is allowed, but the hider's reward is
  // multiplied: 2nd time ×2, 3rd time ×3, … (rulebook: Asking Questions).
  // Set to false to block repeats instead.
  allowRepeatQuestions: true,

  map: {
    center: [45.5089, -73.5617], // Montréal (lat, lng)
    zoom: 11,
    tiles: {
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    },
    // Transit drawn on top of the map (and on top of the shading).
    metro: {
      url: 'data/montreal-transit.geojson', // STM métro + REM lines and stations from OpenStreetMap
      showByDefault: true,
      stationLabelsFromZoom: 14,
      lines: {
        1: { name: 'Ligne verte', colour: '#00A650' },
        2: { name: 'Ligne orange', colour: '#F08123' },
        4: { name: 'Ligne jaune', colour: '#FFD200' },
        5: { name: 'Ligne bleue', colour: '#0083CA' },
        REM: { name: 'REM', colour: '#84BD00' },
      },
      // Station dot outline per system.
      stationStyle: {
        metro: { color: '#1b1b1b' },
        rem: { color: '#4f7a00' },
      },
    },
  },

  // Display units for distances: 'km' or 'mi'. Players can switch in Setup.
  defaultUnits: 'km',

  playArea: {
    defaultPreset: 'transit-core',
    presets: {
      // Everywhere within `radiusM` of a station, with the outer edge smoothed
      // (gaps narrower than 2 × smoothM between circles get filled in).
      // Métro envelope: one smooth outline around the whole métro network.
      // The large smoothM merges everything (including Laval and Longueuil)
      // into a single area with no gaps.
      'transit-core': {
        label: 'Métro area (around the whole network)',
        type: 'station-buffer',
        source: 'data/montreal-transit.geojson',
        radiusM: 1000,
        smoothM: 2500,
        includeSystems: ['metro'], // every station of these systems
        includeStations: {}, // e.g. { rem: ['McGill', 'Gare Centrale'] }
      },
      'montreal-island': {
        label: 'Island of Montréal',
        url: 'data/montreal-island.geojson', // OSM relation 3430571, simplified
      },
    },
  },

  /*
   * Question types. `enabled: false` hides a type without deleting it.
   * `editions.<edition>.options` are the individual questions in the category;
   * each one counts separately for repeats. `sizes` limits an option to some
   * game sizes. Values are in that edition's `unit`.
   * `cost` is what the hider draws after answering.
   * Each answer's `keep` tells the geometry engine which part of the map
   * survives that answer:
   *   radar:       'inside' | 'outside'          (of the circle)
   *   thermometer: 'closerToB' | 'closerToA'     (side of the bisector)
   */
  questions: {
    radar: {
      enabled: true,
      label: 'Radar',
      description: '“Are you within ____ of me?” Measured from the seekers to the hider\'s current location.',
      cost: { draw: 2, keep: 1 },
      editions: {
        metric: {
          unit: 'km',
          options: [
            { id: 'rk-0.5', label: '500 m', value: 0.5 },
            { id: 'rk-1', label: '1 km', value: 1 },
            { id: 'rk-2', label: '2 km', value: 2 },
            { id: 'rk-5', label: '5 km', value: 5 },
            { id: 'rk-10', label: '10 km', value: 10 },
            { id: 'rk-15', label: '15 km', value: 15 },
            { id: 'rk-40', label: '40 km', value: 40 },
            { id: 'rk-80', label: '80 km', value: 80 },
            { id: 'rk-160', label: '160 km', value: 160 },
            { id: 'r-choose', label: 'Choose', custom: true }, // any distance; one question
          ],
        },
        imperial: {
          unit: 'mi',
          options: [
            { id: 'r-0.25', label: '¼ mi', value: 0.25 },
            { id: 'r-0.5', label: '½ mi', value: 0.5 },
            { id: 'r-1', label: '1 mi', value: 1 },
            { id: 'r-3', label: '3 mi', value: 3 },
            { id: 'r-5', label: '5 mi', value: 5 },
            { id: 'r-10', label: '10 mi', value: 10 },
            { id: 'r-25', label: '25 mi', value: 25 },
            { id: 'r-50', label: '50 mi', value: 50 },
            { id: 'r-100', label: '100 mi', value: 100 },
            { id: 'r-choose', label: 'Choose', custom: true },
          ],
        },
      },
      prompt: 'Are you within {radius} of the seekers?',
      answers: [
        { id: 'yes', label: 'Yes, within', keep: 'inside' },
        { id: 'no', label: 'No, outside', keep: 'outside' },
      ],
    },

    thermometer: {
      enabled: true,
      label: 'Thermometer',
      description: '“After traveling ____, am I hotter or colder?” Distance is as the crow flies from A to B.',
      cost: { draw: 2, keep: 1 },
      editions: {
        metric: {
          unit: 'km',
          options: [
            { id: 'tk-1', label: '1 km', value: 1 },
            { id: 'tk-5', label: '5 km', value: 5 },
            { id: 'tk-15', label: '15 km', value: 15, sizes: ['medium', 'large'] },
            { id: 'tk-75', label: '75 km', value: 75, sizes: ['large'] },
          ],
        },
        imperial: {
          unit: 'mi',
          options: [
            { id: 't-0.5', label: '½ mi', value: 0.5 },
            { id: 't-3', label: '3 mi', value: 3 },
            { id: 't-10', label: '10 mi', value: 10, sizes: ['medium', 'large'] },
            { id: 't-50', label: '50 mi', value: 50, sizes: ['large'] },
          ],
        },
      },
      prompt: 'The seekers travelled {option} (actual {distance}) from A to B. Are you hotter (closer to B) or colder (closer to A)?',
      answers: [
        { id: 'hotter', label: 'Hotter (closer to B)', keep: 'closerToB' },
        { id: 'colder', label: 'Colder (closer to A)', keep: 'closerToA' },
      ],
    },
  },
};
