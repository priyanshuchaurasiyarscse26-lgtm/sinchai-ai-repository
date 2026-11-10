/* Sinchai AI — web app: Bluetooth, storage, Google Sheet sync, UI */
(function () {
  'use strict';
  const M = window.SinchaiModel;
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  // ------------------------------------------------------------ storage ---
  const store = {
    get(k, d) { try { const v = localStorage.getItem('sinchai.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('sinchai.' + k, JSON.stringify(v)); return true; } catch (e) { log('Storage full or blocked: ' + e.message); return false; } }
  };

  // ----------------------------------------------------------- settings ---
  // Nordic UART Service: the usual "serial over BLE" UUIDs. The ESP32 sketch uses them.
  const CFG = window.SINCHAI_CONFIG || {};
  const DEFAULTS = {
    gsUrl: CFG.SHEET_URL || '', gsKey: CFG.SHEET_KEY || '', gsReadings: true, gsPreds: true, gsEvery: 60,
    eff: 90, q: 2, es: 0.5, ls: 1.0, wh: 2, ya: 1,
    prefix: 'Sinchai', svc: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', chr: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
    crop: 'tomato', sow: defaultSow(), area: 1, win: '5m', auto: false,
    th: {}
  };
  function defaultSow() {
    const d = new Date(); const y = (d.getMonth() > 9 || (d.getMonth() === 9 && d.getDate() >= 15)) ? d.getFullYear() : d.getFullYear() - 1;
    return y + '-10-15';
  }
  let S = Object.assign({}, DEFAULTS, store.get('settings', {}));
  if (!S.gsUrl && CFG.SHEET_URL) { S.gsUrl = CFG.SHEET_URL; S.gsKey = CFG.SHEET_KEY || S.gsKey; }   // site config fills an empty setting
  const saveSettings = () => store.set('settings', S);
  const th = () => Object.assign({}, M.THRESHOLDS, S.th);

  // -------------------------------------------------------------- state ---
  const KEEP_MS = 26 * 3600000;                 // keep a little over 24 h in the browser
  let readings = store.get('readings', []);
  let preds = store.get('preds', []);
  let queue = store.get('queue', { readings: [], predictions: [] });
  let agg = null;                               // { bucket, list } for per-minute averages
  let deviceName = store.get('deviceName', '');

  const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const fmtTime = ts => new Date(ts).toLocaleString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------------------------------------------------------------- log ---
  const logEl = $('#log'); const logLines = [];
  function log(msg) {
    const line = new Date().toLocaleTimeString('en-US') + '  ' + msg;
    logLines.push(line); if (logLines.length > 300) logLines.shift();
    if (logEl) logEl.textContent = logLines.join('\n');
  }

  function setStatus(el, text, kind) { el.textContent = text; el.className = 'status' + (kind ? ' ' + kind : ''); }
  function setPill(id, text, kind) { const p = $(id); p.className = 'pill' + (kind ? ' ' + kind : ''); p.lastElementChild.textContent = text; }

  // ------------------------------------------------------------- parse ----
  // Accepts:  t:29.1,h:58,p:1006.2,w:2.4,r:0.0   (or k=v, ; separated)
  //           {"t":29.1,"h":58,...}
  //           29.1,58,1006.2,2.4,0.0[,soil]       (fixed order: t,h,p,w,r,s)
  const ALIAS = { t: 't', temp: 't', temperature: 't', h: 'h', hum: 'h', rh: 'h', humidity: 'h', p: 'p', pres: 'p', pressure: 'p',
    w: 'w', wind: 'w', ws: 'w', r: 'r', rain: 'r', s: 's', soil: 's', lux: 'lux', l: 'lux', light: 'lux', bt: 'bt' };
  function parseLine(line) {
    line = line.trim(); if (!line) return null;
    let obj = {};
    if (line[0] === '{') { try { obj = JSON.parse(line); } catch (e) { return null; } }
    else if (/[:=]/.test(line)) {
      for (const part of line.split(/[,;]/)) { const m = part.split(/[:=]/); if (m.length === 2) obj[m[0].trim().toLowerCase()] = m[1]; }
    } else {
      const v = line.split(/[,;\s]+/); ['t', 'h', 'p', 'w', 'r', 's'].forEach((k, i) => { if (v[i] !== undefined && v[i] !== '') obj[k] = v[i]; });
    }
    const r = {};
    for (const [k, v] of Object.entries(obj)) { const key = ALIAS[k.toLowerCase()]; const n = parseFloat(v); if (key && !Number.isNaN(n)) r[key] = n; }
    if (r.t == null && r.bt != null) r.t = r.bt;
    if (r.p != null && r.p < 200) r.p *= 10;   // sent in kPa
    if (r.t == null || Number.isNaN(r.t)) return null;
    return r;
  }

  // ------------------------------------------------------- add reading ----
  function addReading(r, src, opts = {}) {
    const rec = { ts: r.ts || Date.now(), t: r.t, p: r.p ?? null, w: r.w ?? null, r: r.r ?? 0, src };
    if (r.h != null) rec.h = r.h;
    if (r.s != null) rec.s = r.s; if (r.lux != null) rec.lux = r.lux;
    const bad = M.checkReading(rec);
    if (bad.length) log('Out of range (' + bad.join(', ') + '): kept in history, ignored by the model');
    readings.push(rec);
    const cut = Date.now() - KEEP_MS; if (readings[0] && readings[0].ts < cut) readings = readings.filter(x => x.ts >= cut);
    if (!opts.bulk) { persistReadings(); queueReading(rec); renderLive(); renderChartSoon(); renderReadingsSoon(); }
    return rec;
  }
  let persistT; function persistReadings() { clearTimeout(persistT); persistT = setTimeout(() => store.set('readings', readings), 1000); }

  // ------------------------------------------------------ Bluetooth -------
  const bt = { device: null, chr: null, buf: '', flushT: null, manualClose: false, retries: 0 };
  const hasBT = !!(navigator.bluetooth && navigator.bluetooth.requestDevice);

  async function connect() {
    if (!hasBT) return;
    bt.manualClose = false;
    try {
      const svc = S.svc.trim().toLowerCase(); const filters = [];
      if (S.prefix.trim()) filters.push({ namePrefix: S.prefix.trim() });
      filters.push({ services: [svc] });
      setStatus($('#status'), 'Choose your ESP32 in the browser window…');
      log('requestDevice ' + JSON.stringify(filters));
      bt.device = await navigator.bluetooth.requestDevice({ filters, optionalServices: [svc] });
      bt.device.addEventListener('gattserverdisconnected', onDisconnected);
      await openGatt();
    } catch (e) {
      log('Connect failed: ' + e.name + ' ' + e.message);
      setStatus($('#status'), e.name === 'NotFoundError' ? 'No device chosen. Is the ESP32 powered on and advertising as "' + S.prefix + '…"?' : 'Could not connect: ' + e.message, 'err');
      setConnected(false);
    }
  }
  async function openGatt() {
    setStatus($('#status'), 'Connecting to ' + (bt.device.name || 'device') + '…');
    const server = await bt.device.gatt.connect();
    const service = await server.getPrimaryService(S.svc.trim().toLowerCase());
    bt.chr = await service.getCharacteristic(S.chr.trim().toLowerCase());
    bt.chr.addEventListener('characteristicvaluechanged', onValue);
    await bt.chr.startNotifications();
    deviceName = bt.device.name || 'ESP32'; store.set('deviceName', deviceName);
    bt.retries = 0; log('Connected to ' + deviceName + ', notifications on');
    setConnected(true);
  }
  function onValue(e) {
    const text = new TextDecoder().decode(e.target.value);
    bt.buf += text;
    const parts = bt.buf.split(/\r?\n/); bt.buf = parts.pop();
    parts.forEach(handleLine);
    clearTimeout(bt.flushT);                    // a line without "\n": take it after a short pause
    if (bt.buf) bt.flushT = setTimeout(() => { const b = bt.buf; bt.buf = ''; handleLine(b); }, 300);
  }
  function handleLine(line) {
    if (!line.trim()) return;
    log('rx ' + line.trim());
    const r = parseLine(line);
    if (!r) { log('Could not read that line — expected t:…,h:…,p:…,w:…,r:…'); return; }
    addReading(r, 'ble');
    setStatus($('#status'), 'Connected to ' + deviceName + ' · last reading ' + new Date().toLocaleTimeString('en-US'), 'on');
  }
  async function onDisconnected() {
    log('Device disconnected');
    setConnected(false);
    if (bt.manualClose || !bt.device) return;
    if (bt.retries < 3) {
      bt.retries++;
      const wait = 1000 * bt.retries * 2;
      setStatus($('#status'), `Connection lost — retrying (${bt.retries}/3)…`, 'warn');
      setTimeout(() => openGatt().catch(e => { log('Retry failed: ' + e.message); onDisconnected(); }), wait);
    } else setStatus($('#status'), 'Connection lost. Press Connect device to try again.', 'err');
  }
  function disconnect() {
    bt.manualClose = true;
    if (bt.device && bt.device.gatt.connected) bt.device.gatt.disconnect();
    setConnected(false); setStatus($('#status'), 'Disconnected.');
  }
  function setConnected(on) {
    $('#btn-connect').disabled = on || !hasBT;
    $('#btn-disconnect').disabled = !on && !sim.timer;
    setPill('#pill-device', on ? (deviceName || 'Connected') : sim.timer ? 'Simulating' : 'Not connected', on ? 'on' : sim.timer ? 'warn' : '');
  }

  // ------------------------------------------------------ simulator -------
  // Fake ESP32 for testing without hardware: Varanasi-like day, every 5 s.
  const sim = { timer: null };
  function simReading(ts) {
    const d = new Date(ts); const hr = d.getHours() + d.getMinutes() / 60;
    const day = Math.sin(2 * Math.PI * (hr - 9) / 24);
    const n = () => (Math.random() - 0.5);
    const sun = Math.max(0, Math.sin(Math.PI * (hr - 6.3) / 11.4));     // daylight ~06:20-17:40 in November
    // Same sensors as the real node: DS18B20, BMP280, BH1750, rain gauge. No wind (not connected), no humidity.
    return { ts, t: +(23 + 7 * day + n() * 0.4).toFixed(1), bt: +(23.5 + 7 * day + n() * 0.4).toFixed(1), p: +(1008 - 1.5 * day + n() * 0.3).toFixed(1),
      lux: Math.round(sun * 72000 * (0.9 + Math.random() * 0.1)), r: 0 };
  }
  function toggleSim() {
    if (sim.timer) { clearInterval(sim.timer); sim.timer = null; $('#btn-sim').setAttribute('aria-pressed', 'false'); setStatus($('#status'), 'Simulation stopped.'); }
    else {
      const tick = () => { const r = simReading(Date.now()); log('sim ' + `t:${r.t},bt:${r.bt},p:${r.p},lux:${r.lux},r:${r.r}`); addReading(r, 'simulated'); };
      tick(); sim.timer = setInterval(tick, 5000);
      $('#btn-sim').setAttribute('aria-pressed', 'true');
      setStatus($('#status'), 'Simulating an ESP32 — a reading every 5 s. Saved as "simulated".', 'warn');
    }
    setConnected(!!(bt.device && bt.device.gatt && bt.device.gatt.connected));
  }
  function loadDemoDay() {
    const now = Date.now(); let n = 0;
    for (let ts = now - 24 * 3600000; ts < now - 60000; ts += 60000) { addReading(simReading(ts), 'demo', { bulk: true }); n++; }
    readings.sort((a, b) => a.ts - b.ts);
    store.set('readings', readings); renderAll();
    log(`Added ${n} demo readings (1 per minute, last 24 h). Not sent to the sheet.`);
  }

  // ---------------------------------------------------- manual entry ------
  function openManual() { $('#manual-dlg').showModal(); }
  $('#manual-form').addEventListener('submit', e => {
    e.preventDefault();
    const f = new FormData(e.target); const r = {};
    for (const [k, v] of f.entries()) if (v !== '') r[k] = parseFloat(v);
    addReading(r, 'manual'); log('Manual reading added'); $('#manual-dlg').close();
  });
  $('#manual-cancel').addEventListener('click', () => $('#manual-dlg').close());

  // ------------------------------------------------------ live cards ------
  function renderLive() {
    const last = readings[readings.length - 1];
    if (!last) return;
    const rain24 = readings.filter(r => r.ts >= Date.now() - 86400000).reduce((a, r) => a + (r.r || 0), 0);
    const show = { t: [last.t, 1], h: [last.h, 0], p: [last.p, 1], w: [last.w, 1], r: [rain24, 1], s: [last.s, 0], lux: [last.lux, 0] };
    const windAvg = M.CLIMATE.wind[new Date().getMonth()];
    const bad = M.checkReading(last);
    for (const el of $$('.sensor')) {
      const k = el.dataset.k; const [v, d] = show[k];
      if (k === 's' || k === 'h') el.hidden = v == null;
      const sub = el.querySelector('.sub'); if (!sub.dataset.def) sub.dataset.def = sub.textContent;
      sub.textContent = k === 'w' && v == null ? `Not connected · model uses ${windAvg} m/s (Varanasi average)` : sub.dataset.def;
      el.querySelector('.val span').textContent = fmt(v, d);
      el.classList.toggle('bad', bad.includes(k));
    }
    $('#last-update').textContent = 'Updated ' + new Date(last.ts).toLocaleTimeString('en-US') + ' · ' + last.src;
  }

  // ---------------------------------------------------------- chart -------
  let chartT; function renderChartSoon() { clearTimeout(chartT); chartT = setTimeout(renderChart, 400); }
  function renderChart() {
    const k = $('#chart-metric').value; const el = $('#chart');
    const now = Date.now(), from = now - 86400000, B = 5 * 60000;
    const buckets = new Map();
    for (const r of readings) {
      if (r.ts < from || r[k] == null || M.checkReading(r).length) continue;
      const b = Math.floor(r.ts / B) * B; const x = buckets.get(b) || { sum: 0, n: 0 }; x.sum += r[k]; x.n++; buckets.set(b, x);
    }
    const pts = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([b, x]) => [b, k === 'r' ? x.sum : x.sum / x.n]);
    if (pts.length < 2) { el.innerHTML = '<div class="empty">Not enough data yet. Readings from the last 24 hours will show here.</div>'; return; }
    const W = 640, H = 240, L = 44, R = 12, T = 12, Bt = 28;
    let lo = Math.min(...pts.map(p => p[1])), hi = Math.max(...pts.map(p => p[1]));
    if (k === 'r') lo = 0; if (hi - lo < 1) { hi += 0.5; lo -= k === 'r' ? 0 : 0.5; }
    const pad = (hi - lo) * 0.1; hi += pad; if (k !== 'r') lo -= pad;
    const x = t => L + (t - from) / 86400000 * (W - L - R), y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - Bt);
    let g = '';
    for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * i / 4; g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#E6DACA"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#6B5A4A">${fmt(v, hi - lo < 10 ? 1 : 0)}</text>`; }
    for (let h = 0; h <= 24; h += 6) { const t = from + h * 3600000; g += `<text x="${x(t)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#6B5A4A">${h === 24 ? 'now' : new Date(t).toLocaleTimeString('en-US', { hour: 'numeric' })}</text>`; }
    let body;
    if (k === 'r') body = pts.map(([t, v]) => `<rect x="${x(t)}" y="${y(v)}" width="2" height="${y(0) - y(v)}" fill="#437A31"/>`).join('');
    else body = `<polyline fill="none" stroke="#437A31" stroke-width="2" stroke-linejoin="round" points="${pts.map(([t, v]) => x(t).toFixed(1) + ',' + y(v).toFixed(1)).join(' ')}"/>`;
    const names = { t: 'Temperature °C', h: 'Humidity %', w: 'Wind m/s', p: 'Pressure hPa', r: 'Rain mm per 5 min' };
    el.setAttribute('aria-label', names[k] + ' over the last 24 hours, ' + pts.length + ' points, from ' + fmt(Math.min(...pts.map(p => p[1]))) + ' to ' + fmt(Math.max(...pts.map(p => p[1]))));
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${g}${body}</svg><p class="small muted">${names[k]} · 5-minute averages</p>`;
  }

  // ------------------------------------------------------- predict --------
  const CROP_KEYS = Object.keys(M.CROPS);
  $('#crop').innerHTML = CROP_KEYS.map(k => `<option value="${k}">${M.CROPS[k].name}</option>`).join('');

  function predOpts(now) {
    return {
      readings, now: now ?? Date.now(), window: S.win, crop: S.crop, sowDate: S.sow + 'T00:00:00', area: S.area,
      windHeight: S.wh, efficiency: S.eff / 100, yaYm: S.ya, thresholds: S.th,
      drip: { q: S.q, emitterSpacing: S.es, lateralSpacing: S.ls }
    };
  }
  function runPredict(auto) {
    readForm();
    const res = M.predict(predOpts());
    if (!res.ok) { $('#result').innerHTML = `<div class="status err">${esc(res.error)} Connect the ESP32, enter a reading manually, or use Simulate.</div>`; return null; }
    res.sow = S.sow; res.device = deviceName || ''; res.auto = !!auto;
    preds.unshift(slimPred(res)); if (preds.length > 500) preds.length = 500; store.set('preds', preds);
    if (S.gsUrl && S.gsPreds) pushQueue('predictions', sheetPred(res));
    renderResult(res); renderLatest(); renderPreds(); updateSheetPill();
    return res;
  }
  function slimPred(r) {
    return { at: r.at, window: r.window, crop: r.crop, stage: r.stage, dap: r.dap, kc: r.kc, ETo: r.ETo, ETc: r.ETc, Peff: r.Peff, net: r.net, gross: r.gross,
      perHa: r.perHa, area: r.area, total: r.total, runMin: r.runMin, decision: r.decision, etClass: r.etClass, rules: r.rules.map(x => x.text) };
  }
  function renderResult(r) {
    const run = r.runMin != null ? (r.runMin >= 60 ? `${Math.floor(r.runMin / 60)} h ${Math.round(r.runMin % 60)} min` : `${Math.round(r.runMin)} min`) : '—';
    const dText = { IRRIGATE: 'Irrigate', SKIP: 'Skip irrigation today', PAUSE: 'Pause the drip' }[r.decision];
    const i = r.inputs;
    $('#result').innerHTML = `
      <div class="decision ${r.decision}" role="status"><b>${dText}</b><span>${esc(r.crop)} · ${esc(r.stage)} (day ${r.dap}) · water demand ${r.etClass.toLowerCase()}</span></div>
      <div class="big-num"><span class="n">${fmt(r.perHa, 0)}</span><span class="u">litres per hectare per day · ${fmt(r.gross, 2)} mm/day applied · ${fmt(r.m3PerHa, 1)} m³/ha</span>
        <span class="u">For ${fmt(r.area, 2)} ha: <b style="color:#fff">${fmt(r.total, 0)} L/day</b> · drip run time <b style="color:#fff">${run}</b></span></div>
      ${r.rules.length ? '<ul class="rules">' + r.rules.map(x => `<li class="${x.level}">${esc(x.text)}</li>`).join('') + '</ul>' : ''}
      <dl class="kv">
        <div><dt>ETo</dt><dd>${fmt(r.ETo, 2)} <small>mm/day</small></dd></div>
        <div><dt>Kc</dt><dd>${fmt(r.kc, 2)}</dd></div>
        <div><dt>ETc = Kc × ETo</dt><dd>${fmt(r.ETc, 2)} <small>mm/day</small></dd></div>
        <div><dt>Rain, last 24 h</dt><dd>${fmt(r.rain, 1)} <small>mm (eff. ${fmt(r.Peff, 1)})</small></dd></div>
        <div><dt>Net need</dt><dd>${fmt(r.net, 2)} <small>mm/day</small></dd></div>
        <div><dt>Drip efficiency</dt><dd>${fmt(r.efficiency * 100, 0)} <small>%</small></dd></div>
      </dl>
      <details><summary class="small">Inputs the model used (${r.summary.n} readings)</summary>
      <dl class="kv" style="margin-top:10px">
        <div><dt>Tmax / Tmin</dt><dd>${fmt(i.Tmax)} / ${fmt(i.Tmin)} <small>°C</small></dd></div>
        <div><dt>Humidity${i.hSource === 'measured' ? '' : ' (est.)'}</dt><dd>${fmt(i.RH, 0)} <small>%</small></dd></div>
        <div><dt>VPD</dt><dd>${fmt(i.VPD, 2)} <small>kPa</small></dd></div>
        <div><dt>Wind at 2 m${i.windSource === 'measured' ? '' : ' (avg.)'}</dt><dd>${fmt(i.u2)} <small>m/s</small></dd></div>
        <div><dt>Pressure</dt><dd>${fmt(i.P, 2)} <small>kPa</small></dd></div>
        <div><dt>Solar Rs</dt><dd>${fmt(i.Rs)} <small>MJ/m²/day</small></dd></div>
        <div><dt>Net radiation</dt><dd>${fmt(i.Rn, 2)} <small>MJ/m²/day</small></dd></div>
      </dl>
      <p class="small muted" style="margin-top:8px">High/low: ${esc(i.tSource)}. Sunlight: ${esc(i.rsSource)}. Humidity: ${esc(i.hSource)}. Wind: ${esc(i.windSource)}.</p></details>
      ${r.notes.length ? '<ul class="notes">' + r.notes.map(n => `<li>${esc(n)}</li>`).join('') + '</ul>' : ''}
      <p class="small muted">Model threshold-v1 · ${fmtTime(r.at)}${S.gsPreds && S.gsUrl ? ' · queued for the Google Sheet' : ''}</p>`;
  }
  function renderLatest() {
    const p = preds[0]; const el = $('#latest-pred');
    if (!p) return;
    el.innerHTML = `<div class="lp"><span class="meta">${esc(p.crop)} · ${esc(p.stage)} · ${p.window === '24h' ? '24 h' : '5 min'} window</span>
      <span class="n">${fmt(p.perHa, 0)}</span><span class="meta">L/ha/day · ${fmt(p.gross, 2)} mm · ${p.decision === 'IRRIGATE' ? 'Irrigate' : p.decision === 'SKIP' ? 'Skip today' : 'Pause'}</span>
      <span class="meta small">${fmtTime(p.at)}</span></div>`;
  }
  function updateStageLine() {
    readForm();
    const dap = Math.floor((Date.now() - new Date(S.sow + 'T00:00:00')) / 86400000) + 1;
    const c = M.cropStage(S.crop, dap);
    $('#stage-line').textContent = Number.isFinite(dap) ? `Day ${dap} of ${c.seasonDays} · ${c.stage} · Kc ${c.kc.toFixed(2)}` : '';
    const win = S.win === '24h' ? 86400000 : 300000;
    const n = readings.filter(r => r.ts >= Date.now() - win).length;
    $('#data-line').textContent = `${n} reading${n === 1 ? '' : 's'} in the ${S.win === '24h' ? 'last 24 hours' : 'last 5 minutes'}.`;
  }
  function readForm() {
    S.crop = $('#crop').value; S.sow = $('#sow').value || S.sow; S.area = parseFloat($('#area').value) || 1;
    S.win = (document.querySelector('input[name=win]:checked') || {}).value || '5m'; S.auto = $('#auto').checked; saveSettings();
  }
  $('#pred-form').addEventListener('submit', e => { e.preventDefault(); runPredict(false); });
  ['#crop', '#sow', '#area'].forEach(s => $(s).addEventListener('change', updateStageLine));
  $$('input[name=win]').forEach(x => x.addEventListener('change', updateStageLine));
  let autoT = null;
  function setAuto() {
    clearInterval(autoT); autoT = null;
    if (S.auto) { autoT = setInterval(() => { const r = runPredict(true); if (r) log('Auto prediction: ' + Math.round(r.perHa) + ' L/ha/day'); }, 15 * 60000); }
  }
  $('#auto').addEventListener('change', () => { readForm(); setAuto(); });

  // ------------------------------------------------------ history ---------
  let rT; function renderReadingsSoon() { clearTimeout(rT); rT = setTimeout(renderReadings, 800); }
  function renderReadings() {
    const last = readings.slice(-200).reverse();
    $('#readings-count').textContent = `${readings.length.toLocaleString('en-IN')} readings stored in this browser (last 26 h). Showing the latest ${last.length}.`;
    $('#readings-body').innerHTML = last.map(r => `<tr><td>${fmtTime(r.ts)}</td><td>${esc(r.src)}</td><td>${fmt(r.t)}</td><td>${fmt(r.p)}</td><td>${fmt(r.lux, 0)}</td><td>${fmt(r.r, 2)}</td><td>${fmt(r.w)}</td></tr>`).join('')
      || '<tr><td colspan="7" class="muted">No readings yet.</td></tr>';
  }
  function renderPreds() {
    $('#preds-body').innerHTML = preds.slice(0, 200).map(p => `<tr><td>${fmtTime(p.at)}</td><td>${p.window === '24h' ? '24 h' : '5 min'}</td><td>${esc(p.crop)}</td><td>${esc(p.stage)}</td><td>${fmt(p.ETo, 2)}</td><td>${fmt(p.kc, 2)}</td><td>${fmt(p.ETc, 2)}</td><td>${fmt(p.Peff, 1)}</td><td>${fmt(p.perHa, 0)}</td><td><span class="tag-s ${p.decision}">${p.decision}</span></td></tr>`).join('')
      || '<tr><td colspan="10" class="muted">No predictions yet.</td></tr>';
  }
  function downloadCSV(name, header, rows) {
    const q = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const csv = [header, ...rows].map(r => r.map(q).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  $('#dl-readings').addEventListener('click', () => downloadCSV('sinchai-readings.csv', ['time', 'source', 'temp_C', 'humidity_pct', 'pressure_hPa', 'wind_ms', 'rain_mm', 'soil_pct', 'light_lux'],
    readings.map(r => [new Date(r.ts).toISOString(), r.src, r.t, r.h, r.p, r.w, r.r, r.s, r.lux])));
  $('#dl-preds').addEventListener('click', () => downloadCSV('sinchai-predictions.csv', ['time', 'window', 'crop', 'stage', 'DAP', 'Kc', 'ETo_mm', 'ETc_mm', 'rain_eff_mm', 'net_mm', 'gross_mm', 'L_per_ha_day', 'area_ha', 'total_L', 'run_min', 'decision', 'rules'],
    preds.map(p => [new Date(p.at).toISOString(), p.window, p.crop, p.stage, p.dap, p.kc?.toFixed(3), p.ETo?.toFixed(3), p.ETc?.toFixed(3), p.Peff?.toFixed(2), p.net?.toFixed(3), p.gross?.toFixed(3), Math.round(p.perHa), p.area, Math.round(p.total), p.runMin?.toFixed(1), p.decision, (p.rules || []).join(' | ')])));
  $('#clear-readings').addEventListener('click', () => { if (confirm('Delete all readings stored in this browser? Rows already in the Google Sheet stay there.')) { readings = []; store.set('readings', readings); renderAll(); } });
  $('#clear-preds').addEventListener('click', () => { if (confirm('Delete all predictions stored in this browser? Rows already in the Google Sheet stay there.')) { preds = []; store.set('preds', preds); renderAll(); } });

  // ------------------------------------------------- Google Sheet ---------
  function sheetReading(r) { return { ts: r.ts, device: deviceName || '', source: r.src, t: r.t, h: r.h, p: r.p, w: r.w, r: r.r, s: r.s ?? '', lux: r.lux ?? '', n: r.n || 1 }; }
  function sheetPred(r) {
    const i = r.inputs;
    return { ts: r.at, device: r.device, window: r.window, crop: r.crop, sow: r.sow, dap: r.dap, stage: r.stage, kc: +r.kc.toFixed(3),
      tmax: +i.Tmax.toFixed(2), tmin: +i.Tmin.toFixed(2), rh: +i.RH.toFixed(1), u2: +i.u2.toFixed(2), pkpa: +i.P.toFixed(2), rs: +i.Rs.toFixed(2), rsSource: i.rsSource, hSource: i.hSource, windSource: i.windSource,
      rain: +r.rain.toFixed(2), peff: +r.Peff.toFixed(2), eto: +r.ETo.toFixed(3), etc: +r.ETc.toFixed(3), net: +r.net.toFixed(3), gross: +r.gross.toFixed(3),
      perHa: Math.round(r.perHa), area: r.area, total: Math.round(r.total), runMin: r.runMin == null ? '' : +r.runMin.toFixed(1),
      decision: r.decision, etClass: r.etClass, rules: r.rules.map(x => x.text).join(' | '), readings: r.summary.n, model: r.model };
  }
  const QUEUE_MAX = 20000;                       // about 1 day of 5-second readings
  function pushQueue(kind, row) {
    queue[kind].push(row);
    if (queue[kind].length > QUEUE_MAX) queue[kind].splice(0, queue[kind].length - QUEUE_MAX);
    store.set('queue', queue); updateSheetPill();
  }
  function queueReading(rec) {
    if (!S.gsUrl || !S.gsReadings || rec.src === 'demo') return;
    const every = +S.gsEvery;
    if (!every) { pushQueue('readings', sheetReading(rec)); return; }
    const b = Math.floor(rec.ts / (every * 1000));
    if (agg && agg.bucket !== b) flushAgg();
    if (!agg) agg = { bucket: b, list: [] };
    agg.list.push(rec);
  }
  function flushAgg() {
    if (!agg || !agg.list.length) { agg = null; return; }
    const L = agg.list; const avg = k => { const v = L.map(x => x[k]).filter(x => x != null); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null; };
    const row = { ts: L[L.length - 1].ts, src: L[L.length - 1].src, t: avg('t'), h: avg('h'), p: avg('p'), w: avg('w'), r: +L.reduce((a, x) => a + (x.r || 0), 0).toFixed(2), s: avg('s'), lux: avg('lux'), n: L.length };
    pushQueue('readings', sheetReading(row)); agg = null;
  }
  let sending = false;
  async function flushQueue(force) {
    if (agg && force) flushAgg();
    if (!S.gsUrl || sending) return;
    const nR = Math.min(queue.readings.length, 500), nP = Math.min(queue.predictions.length, 100);
    if (!nR && !nP) { if (force) setStatus($('#gs-status'), 'Nothing waiting to send.', 'on'); return; }
    sending = true;
    const body = { key: S.gsKey, readings: queue.readings.slice(0, nR), predictions: queue.predictions.slice(0, nP) };
    try {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 90000);  // never wait forever
      const res = await fetch(S.gsUrl, { method: 'POST', body: JSON.stringify(body), signal: ctl.signal })  // text/plain: no CORS preflight
        .finally(() => clearTimeout(timer));
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || 'the script said no');
      queue.readings.splice(0, nR); queue.predictions.splice(0, nP); store.set('queue', queue);
      sheetState = { ok: true, at: Date.now() };
      setStatus($('#gs-status'), `Sent ${nR} reading${nR === 1 ? '' : 's'} and ${nP} prediction${nP === 1 ? '' : 's'} · ${new Date().toLocaleTimeString('en-US')}`, 'on');
      log(`Sheet: sent ${nR} readings, ${nP} predictions`);
    } catch (e) {
      sheetState = { ok: false, err: e.message };
      setStatus($('#gs-status'), 'Could not send to the sheet: ' + e.message + '. Kept in the queue and will retry.', 'err');
      log('Sheet error: ' + e.message);
    } finally { sending = false; updateSheetPill(); }
  }
  let sheetState = { ok: null };
  function updateSheetPill() {
    const waiting = queue.readings.length + queue.predictions.length;
    if (!S.gsUrl) setPill('#pill-sheet', 'Sheet off', '');
    else if (sheetState.ok === false) setPill('#pill-sheet', `Sheet error · ${waiting} waiting`, 'err');
    else setPill('#pill-sheet', waiting ? `Sheet · ${waiting} waiting` : 'Sheet synced', waiting ? 'warn' : 'on');
  }
  async function testSheet() {
    readSettings();
    if (!S.gsUrl) { setStatus($('#gs-status'), 'Paste the Web App URL first.', 'err'); return; }
    setStatus($('#gs-status'), 'Testing…');
    try {
      const u = new URL(S.gsUrl); u.searchParams.set('key', S.gsKey);
      const j = await (await fetch(u.toString())).json();
      if (!j.ok) throw new Error(j.error || 'not ok');
      setStatus($('#gs-status'), `Connected to “${j.sheet}” · ${j.readings} reading rows, ${j.predictions} prediction rows.`, 'on');
      sheetState = { ok: true };
    } catch (e) { setStatus($('#gs-status'), 'Test failed: ' + e.message + '. Check the URL ends in /exec, access is "Anyone", and the key matches.', 'err'); sheetState = { ok: false }; }
    updateSheetPill();
  }
  $('#gs-test').addEventListener('click', testSheet);
  $('#gs-flush').addEventListener('click', () => { readSettings(); flushQueue(true); });
  setInterval(() => { if (agg && agg.list.length && Date.now() - agg.list[0].ts > S.gsEvery * 1000) flushAgg(); flushQueue(false); }, 30000);
  window.addEventListener('online', () => flushQueue(false));

  // ------------------------------------------------------ settings --------
  const TH_LABELS = {
    rainNowMm: 'Pause if rain in 15 min ≥ (mm)', rainIgnoreMm: 'Ignore daily rain below (mm)', heatC: 'Heat advice at Tmax ≥ (°C)', coldC: 'Cold advice at Tmin ≤ (°C)',
    windStrong: 'Strong wind at ≥ (m/s)', humidHigh: 'Very humid at ≥ (% RH)', soilWet: 'Skip if soil moisture ≥ (%)', soilDry: 'Irrigate soon if soil ≤ (%)', minSpan24hH: '24 h window needs ≥ (hours of data)'
  };
  $('#th-grid').innerHTML = Object.entries(TH_LABELS).map(([k, l]) => `<label>${l}<input type="number" step="any" data-th="${k}"></label>`).join('');
  const FIELDS = { '#gs-url': 'gsUrl', '#gs-key': 'gsKey', '#gs-every': 'gsEvery', '#f-eff': 'eff', '#f-q': 'q', '#f-es': 'es', '#f-ls': 'ls', '#f-wh': 'wh', '#f-ya': 'ya', '#d-prefix': 'prefix', '#d-svc': 'svc', '#d-chr': 'chr' };
  function fillSettings() {
    for (const [sel, k] of Object.entries(FIELDS)) $(sel).value = S[k];
    $('#gs-readings').checked = S.gsReadings; $('#gs-preds').checked = S.gsPreds;
    const T = th(); $$('[data-th]').forEach(i => { i.value = T[i.dataset.th]; });
    $('#crop').value = S.crop; $('#sow').value = S.sow; $('#area').value = S.area; $('#auto').checked = S.auto;
    const w = document.querySelector(`input[name=win][value="${S.win}"]`); if (w) w.checked = true;
  }
  function readSettings() {
    const num = new Set(['gsEvery', 'eff', 'q', 'es', 'ls', 'wh', 'ya']);
    for (const [sel, k] of Object.entries(FIELDS)) { const v = $(sel).value.trim(); S[k] = num.has(k) ? (parseFloat(v) || DEFAULTS[k]) : v; }
    S.gsReadings = $('#gs-readings').checked; S.gsPreds = $('#gs-preds').checked;
    S.th = {}; $$('[data-th]').forEach(i => { const v = parseFloat(i.value); if (!Number.isNaN(v) && v !== M.THRESHOLDS[i.dataset.th]) S.th[i.dataset.th] = v; });
    saveSettings(); updateSheetPill();
  }
  $('#settings-form').addEventListener('submit', e => { e.preventDefault(); readSettings(); $('#saved-msg').textContent = 'Saved.'; setTimeout(() => { $('#saved-msg').textContent = ''; }, 2500); });
  $('#reset-settings').addEventListener('click', () => {
    if (!confirm('Reset all settings to defaults? Your Google Sheet URL and key will be kept.')) return;
    S = Object.assign({}, DEFAULTS, { gsUrl: S.gsUrl, gsKey: S.gsKey }); saveSettings(); fillSettings(); updateStageLine();
  });

  // ---------------------------------------------------------- tabs --------
  function show(view) {
    $$('.tabs [role=tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === view)));
    $$('.view').forEach(v => { v.hidden = v.id !== 'view-' + view; });
    if (view === 'predict') updateStageLine();
    if (view === 'history') { renderReadings(); renderPreds(); }
    try { history.replaceState(null, '', '#' + view); } catch (e) { /* file:// */ }
  }
  $$('.tabs [role=tab]').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));
  $('.tabs').addEventListener('keydown', e => {
    const tabs = $$('.tabs [role=tab]'); const i = tabs.indexOf(document.activeElement); if (i < 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]; n.focus(); show(n.dataset.view); e.preventDefault(); }
  });
  $$('[data-goto]').forEach(b => b.addEventListener('click', () => show(b.dataset.goto)));

  // ----------------------------------------------------------- init -------
  $('#btn-connect').addEventListener('click', connect);
  $('#btn-disconnect').addEventListener('click', () => { if (sim.timer) toggleSim(); disconnect(); });
  $('#btn-manual').addEventListener('click', openManual);
  $('#btn-sim').addEventListener('click', toggleSim);
  $('#btn-demo-day').addEventListener('click', loadDemoDay);
  $('#chart-metric').addEventListener('change', renderChart);

  if (!hasBT) {
    $('#bt-unsupported').hidden = false; $('#bt-hint').hidden = true;
    setStatus($('#status'), 'Bluetooth not available in this browser — you can still enter readings manually.');
  } else if (!window.isSecureContext) {
    setStatus($('#status'), 'Bluetooth needs https:// (or localhost). Open the hosted page.', 'err');
  }
  function renderAll() { renderLive(); renderChart(); renderReadings(); renderPreds(); renderLatest(); updateStageLine(); updateSheetPill(); }
  fillSettings(); setConnected(false); renderAll(); setAuto();
  if (S.gsUrl) setStatus($('#gs-status'), (queue.readings.length + queue.predictions.length) + ' rows waiting to send.');
  const start = (location.hash || '').slice(1); if (['dash', 'predict', 'history', 'settings'].includes(start)) show(start);
  setInterval(renderLive, 60000);
  log('Ready. Bluetooth ' + (hasBT ? 'available' : 'not available') + ' in this browser.');

  // for testing from the console
  window.Sinchai = { parseLine, addReading, readings: () => readings, runPredict, flushQueue, loadDemoDay };
})();
