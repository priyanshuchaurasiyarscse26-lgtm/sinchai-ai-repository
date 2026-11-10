/* =============================================================================
   Sinchai AI — crop water model v1 (threshold based)
   IIT (BHU), Varanasi

   Two layers:
   1. ET layer  — FAO-56 Penman-Monteith, the same equations as
                  tomato_ETc_Oct15_Apr20.py (Eq. 6, 8, 11-14, 21-25, 34, 37-40).
                  ETo  -> Kc from the crop's growth stage -> ETc.
   2. Decision  — fixed thresholds on the sensor readings decide whether to
                  irrigate, skip, or pause, and turn ETc into litres per hectare.

   Runs fully in the browser. No server, no training data needed.
   Swap layer 1 for the ML model later; layer 2 can stay.
   ============================================================================= */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- site ----
  const SITE = { name: 'Varanasi', lat: 25.28, lon: 82.96, elev: 77.2 };   // NASA POWER header

  // Monthly values for Varanasi from NASA POWER daily data, Oct 2015 - Apr 2026.
  // Used only when the sensors cannot give them (no light sensor, short window).
  const CLIMATE = {
    Rs:  [10.2, 16.2, 20.0, 23.0, 22.6, 19.9, 15.9, 15.6, 15.9, 16.2, 12.8, 9.9], // MJ/m2/day
    kRs: [0.114, 0.143, 0.150, 0.153, 0.154, 0.158, 0.157, 0.166, 0.187, 0.175, 0.142, 0.123],
    range: [15.2, 17.0, 17.3, 16.9, 14.1, 10.5, 7.1, 6.2, 6.6, 10.6, 13.2, 14.1], // Tmax-Tmin, C
    Ko:    [4.7, 8.4, 13.1, 18.2, 15.5, 10.8, 1.6, 0.1, 0.0, 1.1, 2.3, 3.3],        // Tmin - Tdew, C (no humidity sensor)
    wind:  [1.6, 1.8, 2.0, 2.3, 2.4, 2.7, 2.5, 2.2, 1.8, 1.4, 1.4, 1.5]             // wind at 2 m, m/s (no wind sensor)
  };

  // ---------------------------------------------------------------- crops ---
  // Kc (initial, mid, end) and stage lengths in days (initial, development,
  // mid-season, late) from FAO-56 Tables 11 and 12. Tomato uses your values and
  // your 15 Oct - 20 Apr season (188 days, the 130-day template stretched).
  const CROPS = {
    tomato:    { name: 'Tomato',    kc: [0.60, 1.15, 0.80], stages: [25, 40, 40, 25],   season: 188, ky: 1.05, h: 0.6 },
    wheat:     { name: 'Wheat',     kc: [0.30, 1.15, 0.30], stages: [15, 25, 50, 30],   season: 120, ky: 1.05, h: 1.0 },
    maize:     { name: 'Maize',     kc: [0.30, 1.20, 0.60], stages: [20, 35, 40, 30],   season: 125, ky: 1.25, h: 2.0 },
    potato:    { name: 'Potato',    kc: [0.50, 1.15, 0.75], stages: [25, 30, 45, 30],   season: 130, ky: 1.10, h: 0.6 },
    chilli:    { name: 'Chilli',    kc: [0.60, 1.05, 0.90], stages: [25, 35, 40, 20],   season: 120, ky: 1.10, h: 0.7 },
    onion:     { name: 'Onion',     kc: [0.70, 1.05, 0.75], stages: [15, 25, 70, 40],   season: 150, ky: 1.10, h: 0.4 },
    sugarcane: { name: 'Sugarcane', kc: [0.40, 1.25, 0.75], stages: [35, 60, 190, 120], season: 405, ky: 1.20, h: 3.0 },
    cotton:    { name: 'Cotton',    kc: [0.35, 1.18, 0.60], stages: [30, 50, 60, 55],   season: 195, ky: 0.85, h: 1.35 }
  };

  // ------------------------------------------------------------ thresholds --
  // Every number the decision layer uses. Change them here (or in Settings).
  const THRESHOLDS = {
    rainNowMm: 0.2,        // rain in the last 15 min at or above this  -> pause drip
    rainIgnoreMm: 1.0,     // daily rain below this does not count (wets leaves only)
    heatC: 40,             // Tmax at or above this -> split into 2 pulses
    coldC: 5,              // Tmin at or below this -> irrigate around midday
    windStrong: 8,         // m/s at 2 m -> strong wind note
    humidHigh: 90,         // mean RH at or above this -> low demand note
    soilWet: 70,           // soil moisture % at or above this -> skip (if sensor fitted)
    soilDry: 35,           // soil moisture % at or below this -> irrigate now
    etClass: [2, 4, 6],    // ETo mm/day: below 2 low, 2-4 moderate, 4-6 high, 6+ very high
    minSpan24hH: 18        // a 24 h window needs at least this many hours of data
  };

  // Sensor values outside these ranges are treated as sensor faults.
  const VALID = {
    t: [-10, 60], h: [0, 100], p: [800, 1100], w: [0, 60], r: [0, 100], s: [0, 100], lux: [0, 200000]
  };

  // ----------------------------------------------------------- FAO-56 bits --
  const e0 = T => 0.6108 * Math.exp(17.27 * T / (T + 237.3));             // Eq.11
  const rad = d => d * Math.PI / 180;

  function dayOfYear(date) {
    const start = Date.UTC(date.getFullYear(), 0, 0);
    const now = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    return Math.round((now - start) / 86400000);
  }

  function solar(doy, latDeg, elev) {
    const L = rad(latDeg);
    const dr = 1 + 0.033 * Math.cos(2 * Math.PI * doy / 365);               // Eq.23
    const dec = 0.409 * Math.sin(2 * Math.PI * doy / 365 - 1.39);           // Eq.24
    const ws = Math.acos(Math.min(1, Math.max(-1, -Math.tan(L) * Math.tan(dec)))); // Eq.25
    const Ra = (24 * 60 / Math.PI) * 0.0820 * dr *
      (ws * Math.sin(L) * Math.sin(dec) + Math.cos(L) * Math.cos(dec) * Math.sin(ws)); // Eq.21
    return { Ra, Rso: (0.75 + 2e-5 * elev) * Ra, N: 24 / Math.PI * ws };    // Eq.37, 34
  }

  // Sun height above the horizon right now (radians), for the light sensor.
  function sunElevation(ms, latDeg, lonDeg) {
    const d = new Date(ms);
    const J = dayOfYear(d);
    const dec = 0.409 * Math.sin(2 * Math.PI * J / 365 - 1.39);              // Eq.24
    const b = 2 * Math.PI * (J - 81) / 364;
    const Sc = 0.1645 * Math.sin(2 * b) - 0.1255 * Math.cos(b) - 0.025 * Math.sin(b); // Eq.32-33, hours
    const solarH = d.getUTCHours() + d.getUTCMinutes() / 60 + lonDeg / 15 + Sc;
    const w = Math.PI / 12 * (solarH - 12);                                   // hour angle
    const L = rad(latDeg);
    return Math.asin(Math.sin(L) * Math.sin(dec) + Math.cos(L) * Math.cos(dec) * Math.cos(w));
  }

  // BH1750 lux -> sunlight W/m2 (daylight is roughly 120 lux per W/m2)
  const LUX_TO_WM2 = 0.0079;

  // Wind measured at height z (m) -> wind at 2 m, FAO-56 Eq.47
  const u2From = (uz, z) => (z === 2 ? uz : uz * 4.87 / Math.log(67.8 * z - 5.42));

  /**
   * Daily FAO-56 Penman-Monteith, G = 0.
   * inp: { Tmax, Tmin, ea (kPa) or Tdew, u2 (m/s), Rs (MJ/m2/day), P (kPa), doy, lat, elev }
   */
  function fao56Daily(inp) {
    const lat = inp.lat ?? SITE.lat, elev = inp.elev ?? SITE.elev;
    const { Ra, Rso } = solar(inp.doy, lat, elev);
    const Tmean = (inp.Tmax + inp.Tmin) / 2;                                // Eq.9
    const es = (e0(inp.Tmax) + e0(inp.Tmin)) / 2;                           // Eq.12
    const ea = Math.min(inp.ea ?? e0(inp.Tdew), es);                        // Eq.14
    const D = 4098 * e0(Tmean) / Math.pow(Tmean + 237.3, 2);                // Eq.13
    const g = 0.000665 * inp.P;                                             // Eq.8
    const Rs = inp.Rs;
    const Rns = 0.77 * Rs;                                                  // Eq.38
    const Rnl = 4.903e-9 * ((Math.pow(inp.Tmax + 273.16, 4) + Math.pow(inp.Tmin + 273.16, 4)) / 2) *
      (0.34 - 0.14 * Math.sqrt(Math.max(ea, 0))) *
      (1.35 * Math.min(1, Math.max(0, Rs / Rso)) - 0.35);                   // Eq.39
    const Rn = Rns - Rnl;                                                   // Eq.40
    const den = D + g * (1 + 0.34 * inp.u2);
    const ETrad = 0.408 * D * Rn / den;
    const ETaero = g * 900 / (Tmean + 273) * inp.u2 * (es - ea) / den;
    return { ETo: Math.max(0, ETrad + ETaero), ETrad, ETaero, Rn, Ra, Rso, es, ea, VPD: es - ea, Tmean };
  }

  // ------------------------------------------------------------ Kc curve ----
  // Same shape as kc_curve() in your Python: flat, linear rise, flat, linear fall.
  // FAO-56 Eq.62 climate adjustment of Kc mid and Kc end, as in your Python
  // (CLIMATE_ADJUST = True). u2 and RHmin come from the analysed window.
  function kcAdjust(cropKey, u2, RHmin) {
    const c = CROPS[cropKey];
    if (u2 == null || RHmin == null || Number.isNaN(u2) || Number.isNaN(RHmin)) return 0;
    const u = Math.min(6, Math.max(1, u2)), rh = Math.min(80, Math.max(20, RHmin));   // FAO-56 valid ranges
    return (0.04 * (u - 2) - 0.004 * (rh - 45)) * Math.pow(c.h / 3, 0.3);
  }

  function cropStage(cropKey, dap, seasonDays, adj = 0) {
    const c = CROPS[cropKey];
    const n = seasonDays || c.season;
    const base = c.stages, sum = base.reduce((a, b) => a + b, 0);
    const st = base.map(b => Math.round(b * n / sum));
    st[3] += n - st.reduce((a, b) => a + b, 0);
    const [L1, L2, L3, L4] = st;
    const ki = c.kc[0], km = c.kc[1] + adj, ke = c.kc[2] + adj;
    const d = Math.max(0, dap - 1);                                         // DAP 1 -> index 0
    let stage, kc;
    if (dap < 1) { stage = 'not sown yet'; kc = 0; }
    else if (d < L1) { stage = 'initial'; kc = ki; }
    else if (d < L1 + L2) { stage = 'development'; kc = ki + (km - ki) * (d - L1 + 1) / L2; }
    else if (d < L1 + L2 + L3) { stage = 'mid-season'; kc = km; }
    else if (d < n) { stage = 'late-season'; kc = km + (ke - km) * (d - L1 - L2 - L3 + 1) / L4; }
    else { stage = 'season over'; kc = ke; }
    return { stage, kc, dap, seasonDays: n, stageDays: st, adj };
  }

  // ------------------------------------------------------- effective rain ---
  // Your USDA-SCS rule applied to the last 24 h of rain (what your pipeline gives
  // when that rain is the only rain so far). Light rain below the threshold counts 0.
  function effectiveRain(mm, th = THRESHOLDS) {
    if (!(mm >= th.rainIgnoreMm)) return 0;
    return Math.max(0, mm <= 250 ? mm * (125 - 0.2 * mm) / 125 : 125 + 0.1 * mm);
  }

  // -------------------------------------------------- reading validation ----
  function checkReading(r) {
    const bad = [];
    for (const k of Object.keys(VALID)) {
      if (r[k] == null || Number.isNaN(r[k])) continue;
      const [lo, hi] = VALID[k];
      if (r[k] < lo || r[k] > hi) bad.push(k);
    }
    return bad;
  }

  // ------------------------------------------------------ window summary ----
  /** readings: [{ts, t, h, p (hPa), w (m/s), r (mm since last reading), s?, lux?}] */
  function summarise(readings, now) {
    const ok = readings.filter(r => checkReading(r).length === 0 && r.t != null && !Number.isNaN(r.t));
    if (!ok.length) return null;
    const ts = ok.map(r => r.ts);
    const mean = k => {
      const v = ok.map(r => r[k]).filter(x => x != null && !Number.isNaN(x));
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const sum = k => ok.reduce((a, r) => a + (r[k] || 0), 0);
    const last15 = ok.filter(r => r.ts >= now - 15 * 60000).reduce((a, r) => a + (r.r || 0), 0);
    const T = ok.map(r => r.t);
    const lastSoil = [...ok].reverse().find(r => r.s != null);
    const withH = ok.filter(r => r.h != null);
    const recent = ok.filter(r => r.ts >= Math.max(...ok.map(x => x.ts)) - 5 * 60000 && r.lux != null);
    return {
      n: ok.length, rejected: readings.length - ok.length,
      from: Math.min(...ts), to: Math.max(...ts),
      spanH: (Math.max(...ts) - Math.min(...ts)) / 3600000,
      Tmean: mean('t'), Tmax: Math.max(...T), Tmin: Math.min(...T),
      RH: mean('h'),                                                         // null: no humidity sensor
      ea: withH.length ? withH.reduce((a, r) => a + r.h / 100 * e0(r.t), 0) / withH.length : null,
      P: mean('p'), wind: mean('w'), rain: sum('r'), rain15: last15,
      soil: lastSoil ? lastSoil.s : null, lux: mean('lux'),
      luxNow: recent.length ? recent.reduce((a, r) => a + r.lux, 0) / recent.length : null
    };
  }

  // ---------------------------------------------------------- prediction ----
  /**
   * opts: {
   *   readings, window: '5m' | '24h', crop, sowDate (Date), area (ha), now (ms),
   *   windHeight (m), efficiency (0-1), yaYm (0-1),
   *   drip: { q: L/h per emitter, emitterSpacing: m, lateralSpacing: m },
   *   thresholds: partial override of THRESHOLDS
   * }
   */
  function predict(opts) {
    const th = Object.assign({}, THRESHOLDS, opts.thresholds || {});
    const now = opts.now ?? Date.now();
    const winMs = opts.window === '24h' ? 86400000 : 5 * 60000;
    const inWin = opts.readings.filter(r => r.ts >= now - winMs && r.ts <= now);
    const S = summarise(inWin, now);
    if (!S) return { ok: false, error: 'No valid readings in the last ' + (opts.window === '24h' ? '24 hours' : '5 minutes') + '.' };

    const date = new Date(now);
    const month = date.getMonth();
    const doy = dayOfYear(date);
    const { Ra, Rso } = solar(doy, SITE.lat, SITE.elev);
    const notes = [];

    // ---- Tmax / Tmin ----------------------------------------------------
    let Tmax = S.Tmax, Tmin = S.Tmin, tSource = 'measured';
    const full24 = opts.window === '24h' && S.spanH >= th.minSpan24hH;
    if (!full24) {
      // Not a full day: place the latest 15 min of temperature on a typical
      // day curve (low near 03:00, high near 15:00) to get the day's mean.
      const half = CLIMATE.range[month] / 2;
      const recent = inWin.filter(r => r.ts >= S.to - 15 * 60000 && r.t != null && checkReading(r).length === 0);
      const tNow = recent.reduce((a, r) => a + r.t, 0) / recent.length;
      const lt = new Date(S.to); const hr = lt.getHours() + lt.getMinutes() / 60;
      const Tday = tNow - half * Math.sin(2 * Math.PI * (hr - 9) / 24);
      Tmax = Tday + half; Tmin = Tday - half; tSource = 'estimated from the time of day and the typical range for this month';
      if (opts.window === '24h') notes.push(`Only ${S.spanH.toFixed(1)} h of data in the last 24 h, so the day's high and low are estimated.`);
    }

    // ---- humidity -------------------------------------------------------
    // BMP280 has no humidity: dew point = Tmin - Ko (FAO-56 Annex 6), with Ko
    // fitted to Varanasi NASA POWER data for each month.
    let ea = S.ea, hSource = 'measured';
    if (ea == null) { ea = e0(Tmin - CLIMATE.Ko[month]); hSource = 'estimated from the night low (no humidity sensor)'; }
    const RHshow = S.RH != null ? S.RH : Math.min(100, 100 * ea / e0((Tmax + Tmin) / 2));

    // ---- solar radiation ------------------------------------------------
    let Rs, rsSource;
    const elev = sunElevation(S.to, SITE.lat, SITE.lon);
    if (S.lux != null && full24) {
      Rs = Math.min(S.lux * LUX_TO_WM2 * 0.0864, Rso);                     // mean W/m2 over the day -> MJ/m2/day
      rsSource = 'light sensor (BH1750), 24 h';
    } else if (S.luxNow != null && elev > rad(15)) {
      // Daytime quick check: how bright is it now compared with a clear sky at this sun height?
      const clearNow = 0.75 * 1367 * Math.sin(elev);                         // W/m2
      const k = Math.min(1, Math.max(0.25, S.luxNow * LUX_TO_WM2 / clearNow));
      Rs = Rso * k;
      rsSource = `light sensor (BH1750) now: ${Math.round(k * 100)} % of clear sky`;
    } else if (full24) {
      Rs = Math.min(CLIMATE.kRs[month] * Math.sqrt(Math.max(Tmax - Tmin, 0)) * Ra, Rso); // Eq.50, kRs fitted to Varanasi
      rsSource = 'from temperature range';
    } else {
      Rs = Math.min(CLIMATE.Rs[month], Rso);
      rsSource = 'Varanasi average for this month';
    }

    // ---- wind and pressure ---------------------------------------------
    let u2, windSource = 'measured';
    if (S.wind != null) u2 = Math.max(0.5, u2From(S.wind, opts.windHeight || 2));   // FAO-56 floor of 0.5 m/s
    else { u2 = CLIMATE.wind[month]; windSource = 'Varanasi average for this month (wind sensor not connected)'; }
    const PkPa = S.P ? S.P / 10 : 101.3 * Math.pow((293 - 0.0065 * SITE.elev) / 293, 5.26);

    const et = fao56Daily({ Tmax, Tmin, ea, u2, Rs, P: PkPa, doy });

    // ---- crop ---------------------------------------------------------------
    const crop = CROPS[opts.crop] || CROPS.tomato;
    const dap = Math.floor((now - new Date(opts.sowDate).setHours(0, 0, 0, 0)) / 86400000) + 1;
    const cropKey = opts.crop in CROPS ? opts.crop : 'tomato';
    const RHmin = 100 * et.ea / e0(Tmax);                                      // FAO-56 Eq.63 estimate
    const adj = opts.climateAdjust === false ? 0 : kcAdjust(cropKey, u2, RHmin);
    const cs = cropStage(cropKey, dap, opts.seasonDays, adj);
    const ETc = cs.kc * et.ETo;
    const yaYm = opts.yaYm ?? 1;
    const ETa = (1 - (1 / crop.ky) * (1 - yaYm)) * ETc;                     // as in Equation 10

    // ---- rain ---------------------------------------------------------------
    // Always the last 24 h of rain, whichever window is analysed.
    const rainDay = opts.readings
      .filter(r => r.ts >= now - 86400000 && r.ts <= now && checkReading(r).length === 0)
      .reduce((a, r) => a + (r.r || 0), 0);
    const Peff = effectiveRain(rainDay, th);

    // ---- thresholds -> decision ----------------------------------------------
    const rules = [];
    let decision = 'IRRIGATE';
    const add = (level, text, id) => rules.push({ level, text, id });

    if (cs.stage === 'not sown yet') { decision = 'SKIP'; add('stop', 'Sowing date is in the future — nothing to irrigate yet.', 'sow'); }
    if (S.rain15 >= th.rainNowMm) { decision = 'PAUSE'; add('stop', `Raining now (${S.rain15.toFixed(1)} mm in 15 min) — pause the drip.`, 'rainNow'); }
    if (S.soil != null && S.soil >= th.soilWet) { if (decision === 'IRRIGATE') decision = 'SKIP'; add('stop', `Soil moisture ${S.soil.toFixed(0)} % is at or above ${th.soilWet} % — soil is wet enough.`, 'soilWet'); }
    if (S.soil != null && S.soil <= th.soilDry) add('warn', `Soil moisture ${S.soil.toFixed(0)} % is at or below ${th.soilDry} % — irrigate soon.`, 'soilDry');
    if (Tmax >= th.heatC) add('warn', `Hot day (${Tmax.toFixed(1)} °C) — split the water into 2 pulses, early morning and evening.`, 'heat');
    if (Tmin <= th.coldC) add('warn', `Cold (${Tmin.toFixed(1)} °C) — irrigate around midday.`, 'cold');
    if (u2 >= th.windStrong) add('info', `Strong wind (${u2.toFixed(1)} m/s) — crop water use is high today.`, 'wind');
    if (S.RH != null && S.RH >= th.humidHigh && rainDay < th.rainIgnoreMm) add('info', `Very humid (${S.RH.toFixed(0)} %) — crop water use is low.`, 'humid');

    let net = Math.max(0, ETa - Peff);
    if (Peff > 0 && net === 0) { if (decision === 'IRRIGATE') decision = 'SKIP'; add('stop', `Rain covers today's need (${Peff.toFixed(1)} mm effective of ${ETa.toFixed(1)} mm).`, 'rainCovers'); }
    else if (Peff > 0) add('info', `Rain gave ${Peff.toFixed(1)} mm — taken off the requirement.`, 'rainPart');
    if (decision !== 'IRRIGATE') net = 0;

    const eff = opts.efficiency || 0.9;
    const gross = net / eff;                                                // mm/day to apply
    const perHa = gross * 10000;                                            // 1 mm over 1 ha = 10,000 L
    const area = opts.area || 1;

    // ---- drip run time -------------------------------------------------------
    let runMin = null, emittersPerHa = null;
    const dr = opts.drip;
    if (dr && dr.q > 0 && dr.emitterSpacing > 0 && dr.lateralSpacing > 0) {
      emittersPerHa = 10000 / (dr.emitterSpacing * dr.lateralSpacing);
      runMin = perHa / (emittersPerHa * dr.q) * 60;
    }

    const [c1, c2, c3] = th.etClass;
    const etClass = et.ETo < c1 ? 'Low' : et.ETo < c2 ? 'Moderate' : et.ETo < c3 ? 'High' : 'Very high';
    if (S.rejected) notes.push(`${S.rejected} reading(s) were out of range and left out.`);
    if (S.RH == null) notes.push('No humidity sensor: humidity is estimated from the night low temperature.');
    if (S.wind == null) notes.push(`Wind sensor not connected: using the Varanasi average for this month (${u2.toFixed(1)} m/s).`);
    if (opts.window === '5m') notes.push('5-minute window: a quick estimate from current conditions, as if they held all day.');

    return {
      ok: true, model: 'threshold-v1', at: now, window: opts.window,
      decision, etClass, rules, notes,
      crop: crop.name, cropKey, stage: cs.stage, dap: cs.dap, kc: cs.kc, kcAdj: adj,
      ETo: et.ETo, ETc, ETa, rain: rainDay, Peff, net, gross, perHa,
      m3PerHa: perHa / 1000, area, total: perHa * area, efficiency: eff,
      runMin, emittersPerHa,
      inputs: { Tmax, Tmin, Tmean: S.Tmean, RH: RHshow, RHmin, hSource, windSource, ea: et.ea, VPD: et.VPD, u2, P: PkPa, Rs, Rn: et.Rn, tSource, rsSource, soil: S.soil },
      summary: S
    };
  }

  global.SinchaiModel = { SITE, CLIMATE, CROPS, THRESHOLDS, VALID, e0, solar, u2From, fao56Daily, sunElevation, cropStage, kcAdjust, effectiveRain, checkReading, summarise, predict, dayOfYear };
})(typeof window !== 'undefined' ? window : globalThis);
