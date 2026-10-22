(() => {
  // CornGrid Market Overview: candlestick chart, timeframe tools, and per-user drawings.
  // Depends on vendor/lightweight-charts (Apache-2.0, TradingView) and the /api/market endpoints.
  const API = '/api';
  const SYMBOL_LABELS = { XAUUSD: 'Gold / US Dollar', EURUSD: 'Euro / US Dollar', GBPUSD: 'British Pound / US Dollar', USDJPY: 'US Dollar / Japanese Yen' };
  const DECIMALS = { XAUUSD: 2, EURUSD: 5, GBPUSD: 5, USDJPY: 3 };
  const TF_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };
  const STATE_CLASS = { LIVE: 'pill-live', DELAYED: 'pill-delayed', STALE: 'pill-stale', OFFLINE: 'pill-offline', FALLBACK: 'pill-fallback' };
  const STATE_RANK = { LIVE: 3, DELAYED: 2, STALE: 1, OFFLINE: 0 };
  const state = {
    pageOpen: false,
    hovering: false,
    candleSource: null,
    stats: null,
    live: {
      source: null, feed: null, bid: null, ask: null, spread: null, spreadPoints: null, digits: null,
      state: 'OFFLINE', quiet: false, anchor: 0, receivedMs: 0, rev: 0, tickTime: null, limits: null,
      es: null, pollTimer: null, guardTimer: null, polling: false, message: ''
    },
    watchdogTimer: null,
    watchdogTicks: 0,
    symbol: 'XAUUSD',
    interval: '1h',
    chart: null,
    candleSeries: null,
    volumeSeries: null,
    trendOverlay: null,
    drawings: [],
    priceLines: new Map(),
    activeTool: null,
    trendStart: null,
    pendingEdit: null,
    summary: null,
    loaded: false,
    requestSeq: 0
  };

  const $ = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }

  function toast(message, type = '') {
    const region = $('#toast-region');
    if (!region) return;
    const item = document.createElement('div');
    item.className = `toast ${type ? `toast-${type}` : ''}`;
    item.textContent = message;
    region.append(item);
    window.setTimeout(() => item.remove(), 4500);
  }

  async function request(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      ...options,
      credentials: 'same-origin',
      signal: options.signal || AbortSignal.timeout(20000),
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
    });
    let data = {};
    try { data = await response.json(); } catch { if (response.ok) throw new Error('The server returned an invalid response.'); }
    if (response.status === 401 || response.status === 403) {
      throw new Error('Your session has expired. Please sign in again.');
    }
    if (!response.ok) {
      const failure = new Error(data.error || 'The request could not be completed.');
      failure.data = data;
      throw failure;
    }
    return data;
  }

  function decimals() {
    const live = state.live;
    if (live.source === 'corngrid-ea' && Number.isInteger(live.digits)) return live.digits;
    return DECIMALS[state.symbol] ?? 2;
  }
  function formatPrice(value) {
    if (!Number.isFinite(value)) return 'N/A';
    return new Intl.NumberFormat(undefined, { minimumFractionDigits: decimals(), maximumFractionDigits: decimals() }).format(value);
  }

  function setChartState(mode, message) {
    const overlay = $('market-chart-state');
    if (!overlay) return;
    overlay.className = `market-chart-state market-state-${mode}`;
    if (mode === 'hidden') { overlay.hidden = true; return; }
    overlay.hidden = false;
    const text = message || (mode === 'loading' ? 'Loading market data…' : '');
    overlay.innerHTML = mode === 'loading'
      ? `<span class="market-spinner" aria-hidden="true"></span><strong>${escapeHtml(text)}</strong>`
      : `<strong>${escapeHtml(text)}</strong><button type="button" class="button button-primary button-small" id="market-retry">Try again</button>`;
    const retry = $('market-retry');
    if (retry) retry.addEventListener('click', () => { loadSummary(); loadCandles(); loadDrawings(); });
  }

  function ensureChart() {
    if (state.chart || !window.LightweightCharts) return;
    const container = $('market-chart');
    if (!container) return;
    const light = document.body.classList.contains('theme-light');
    state.chart = LightweightCharts.createChart(container, {
      autoSize: true,
      layout: {
        background: { type: LightweightCharts.ColorType.Solid, color: 'transparent' },
        textColor: light ? '#697182' : '#a0a6b4',
        fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
        fontSize: 11
      },
      grid: {
        vertLines: { color: light ? 'rgba(0,0,0,.06)' : 'rgba(255,255,255,.05)' },
        horzLines: { color: light ? 'rgba(0,0,0,.06)' : 'rgba(255,255,255,.05)' }
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: 'rgba(255,212,0,.5)', width: 1, style: LightweightCharts.LineStyle.Dashed, labelBackgroundColor: '#ffd400' },
        horzLine: { color: 'rgba(255,212,0,.5)', width: 1, style: LightweightCharts.LineStyle.Dashed, labelBackgroundColor: '#ffd400' }
      },
      rightPriceScale: { borderColor: light ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.08)' },
      timeScale: { borderColor: light ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.08)', timeVisible: true, secondsVisible: false },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: false } }
    });
    state.candleSeries = state.chart.addCandlestickSeries({
      upColor: '#23cf8b',
      downColor: '#ff737d',
      borderUpColor: '#23cf8b',
      borderDownColor: '#ff737d',
      wickUpColor: 'rgba(35,207,139,.75)',
      wickDownColor: 'rgba(255,115,125,.75)',
      priceLineColor: 'rgba(255,212,0,.65)',
      lastValueVisible: true
    });
    // OHLC legend follows the crosshair; falls back to the latest candle.
    state.chart.subscribeCrosshairMove(param => {
      const value = param && param.seriesData && param.seriesData.get(state.candleSeries);
      state.hovering = Boolean(value);
      renderOhlc(value || state.lastCandle || null);
    });
    // Overlay layer for trend lines (lightweight-charts has no built-in trend drawing).
    const overlay = document.createElement('div');
    overlay.className = 'market-trend-overlay';
    $('market-chart-wrap').appendChild(overlay);
    state.trendOverlay = overlay;
    const redraw = () => renderTrendLines();
    state.chart.timeScale().subscribeVisibleTimeRangeChange(redraw);
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => { redraw(); });
      ro.observe($('market-chart-wrap'));
      state.resizeObserver = ro;
    }
  }

  function renderOhlc(candle) {
    const host = $('market-ohlc');
    if (!host || !candle) return;
    host.innerHTML = [
      ['O', candle.open], ['H', candle.high], ['L', candle.low], ['C', candle.close]
    ].map(([label, value]) => `<span>${label} <b>${escapeHtml(formatPrice(value))}</b></span>`).join('');
  }

  // Trend lines are stored as two {time, price} points and drawn on an HTML overlay
  // because lightweight-charts does not provide trend drawing primitives.
  //
  // A saved point keeps the timestamp of the bar it was placed on. After the
  // timeframe changes that timestamp no longer falls on a bar, so the point is
  // re-anchored onto the nearest bar of the current timeframe. That keeps the
  // line visible and in the right place instead of disappearing.
  function anchorTrendPoints(drawing) {
    const points = (drawing.data && drawing.data.points) || [];
    if (points.length !== 2 || !state.candleSeries) return null;
    const bars = state.candleSeries.data() || [];
    if (!bars.length) return null;
    const anchored = points.map(point => {
      const time = snapToBarTime(point.time, bars);
      return time == null ? null : { time, price: point.price };
    });
    if (anchored.some(point => point == null)) return null;
    return anchored;
  }

  // Finds the bar whose time is closest to the given timestamp.
  function snapToBarTime(time, bars) {
    if (!Number.isFinite(time) || !bars.length) return null;
    let best = null;
    let bestDistance = Infinity;
    for (const bar of bars) {
      const distance = Math.abs(bar.time - time);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = bar.time;
      }
    }
    return best;
  }

  function renderTrendLines() {
    const overlay = state.trendOverlay;
    if (!overlay || !state.chart) return;
    overlay.innerHTML = '';
    const scale = state.chart.timeScale();
    const trends = state.drawings.filter(drawing => drawing.kind === 'trend');
    for (const drawing of trends) {
      const points = anchorTrendPoints(drawing);
      if (!points) continue;
      const coords = points.map(point => ({
        x: scale.timeToCoordinate(point.time),
        y: state.candleSeries.priceToCoordinate(point.price)
      }));
      if (coords.some(coord => coord == null || coord.x == null || coord.y == null)) continue;
      const line = document.createElement('div');
      line.className = 'market-trend-line';
      const dx = coords[1].x - coords[0].x;
      const dy = coords[1].y - coords[0].y;
      const length = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx) * 180 / Math.PI;
      line.style.width = `${length}px`;
      line.style.left = `${coords[0].x}px`;
      line.style.top = `${coords[0].y}px`;
      line.style.transform = `rotate(${angle}deg)`;
      line.title = `Trend line ${formatPrice(points[0].price)} → ${formatPrice(points[1].price)}`;
      overlay.appendChild(line);
      // End-point markers carrying the marked price.
      coords.forEach((coord, index) => {
        const dot = document.createElement('div');
        dot.className = 'market-trend-dot';
        dot.style.left = `${coord.x}px`;
        dot.style.top = `${coord.y}px`;
        dot.title = formatPrice(points[index].price);
        overlay.appendChild(dot);
      });
    }
  }

  function priceLineOptions(drawing) {
    return {
      price: drawing.data.price,
      color: 'rgba(255,212,0,.8)',
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title: `L ${formatPrice(drawing.data.price)}`
    };
  }

  function addDrawingToChart(drawing) {
    // Never apply the same drawing twice: a second price line for the same id
    // would be orphaned on the chart and could not be removed later.
    if (state.priceLines.has(drawing.id)) return;
    if (drawing.kind === 'hline' && state.candleSeries) {
      const line = state.candleSeries.createPriceLine(priceLineOptions(drawing));
      state.priceLines.set(drawing.id, line);
    }
    renderTrendLines();
  }

  function removeDrawingFromChart(drawing) {
    if (drawing.kind === 'hline' && state.priceLines.has(drawing.id) && state.candleSeries) {
      state.candleSeries.removePriceLine(state.priceLines.get(drawing.id));
      state.priceLines.delete(drawing.id);
    }
    renderTrendLines();
  }

  // Drops every price line currently on the chart. Used before the series is
  // re-filled (timeframe or symbol change) so lines are never duplicated and
  // never left behind as orphans that cannot be deleted.
  function clearChartPriceLines() {
    if (!state.candleSeries) {
      state.priceLines.clear();
      return;
    }
    for (const line of state.priceLines.values()) {
      try { state.candleSeries.removePriceLine(line); } catch { /* line already detached */ }
    }
    state.priceLines.clear();
  }

  function describeDrawing(drawing) {
    if (drawing.kind === 'hline') return `Horizontal line at ${formatPrice(drawing.data.price)}`;
    const points = drawing.data.points || [];
    return `Trend line ${formatPrice(points[0] && points[0].price)} → ${formatPrice(points[1] && points[1].price)}`;
  }

  function renderDrawingsList() {
    const host = $('market-drawings-list');
    if (!host) return;
    if (!state.drawings.length) {
      host.innerHTML = '<p class="muted small">No drawings yet for this symbol. Horizontal lines and trend lines you place are saved to your account.</p>';
      return;
    }
    host.innerHTML = state.drawings.map(drawing => `
      <div class="market-drawing-item">
        <span class="market-drawing-kind">${drawing.kind === 'hline' ? '— H-Line' : '／ Trend'}</span>
        <span class="market-drawing-desc">${escapeHtml(describeDrawing(drawing))}</span>
        <button type="button" class="button button-secondary button-small" data-remove-drawing="${escapeHtml(drawing.id)}" title="Remove drawing">✕</button>
      </div>`).join('');
    host.querySelectorAll('[data-remove-drawing]').forEach(button => {
      button.addEventListener('click', () => removeDrawing(Number(button.dataset.removeDrawing)));
    });
  }


  // Connection state shown to the user: server state, downgraded locally if updates stop arriving.
  function localState() {
    const live = state.live;
    if (live.source !== 'corngrid-ea') return live.state;
    const limits = live.limits || { liveSeconds: 10, delayedSeconds: 30, staleSeconds: 120 };
    const age = (Date.now() - live.anchor) / 1000;
    const byAge = age <= limits.liveSeconds ? 'LIVE' : age <= limits.delayedSeconds ? 'DELAYED' : age <= limits.staleSeconds ? 'STALE' : 'OFFLINE';
    return STATE_RANK[byAge] < STATE_RANK[live.state] ? byAge : live.state;
  }

  function setConnState(name, detail) {
    const pill = $('market-data-status');
    pill.textContent = detail ? `${name} · ${detail}` : name;
    pill.className = `pill ${STATE_CLASS[name] || 'pill-muted'}`;
  }

  function renderChange(change, percent) {
    const text = change == null ? 'N/A' : `${change >= 0 ? '+' : ''}${formatPrice(change)}${percent == null ? '' : ` (${change >= 0 ? '+' : ''}${percent.toFixed(2)}%)`}`;
    const tone = change == null ? '' : change >= 0 ? 'positive' : 'negative';
    $('market-change').textContent = change == null ? '—' : text;
    $('market-change').className = `market-change ${tone}`;
    $('info-change').textContent = text;
    $('info-change').className = tone;
  }

  function renderLive() {
    const live = state.live;
    if (live.source !== 'corngrid-ea') return;
    const current = localState();
    const usable = current === 'LIVE' || current === 'DELAYED';
    const fmt = value => (value == null ? '—' : formatPrice(value));
    const spreadText = live.spreadPoints != null ? `${live.spreadPoints} pts` : live.spread != null ? formatPrice(live.spread) : '—';
    $('market-price').textContent = fmt(live.bid);
    $('market-price').classList.toggle('muted', !usable);
    $('market-quote-meta').textContent = `Bid ${fmt(live.bid)} · Ask ${fmt(live.ask)} · Spread ${spreadText}`;
    $('info-bid').textContent = fmt(live.bid);
    $('info-ask').textContent = fmt(live.ask);
    $('info-spread').textContent = spreadText;
    $('info-close').textContent = fmt(live.bid);
    const prev = state.stats && state.stats.previousClose;
    if (live.bid != null && prev) renderChange(live.bid - prev, ((live.bid - prev) / prev) * 100);
    else renderChange(null, null);
    const detail = current === 'LIVE' && live.quiet ? 'no new ticks (market quiet?)' : current === 'OFFLINE' ? 'CornGrid EA not publishing' : current === 'STALE' ? 'prices are old' : '';
    setConnState(current, detail);
    $('market-source').textContent = `Source: CornGrid EA broker feed${live.feed ? ` (${live.feed})` : ''}${live.brokerSymbol ? ` · ${live.brokerSymbol}` : ''}`;
    const received = live.receivedMs ? new Date(live.receivedMs).toLocaleTimeString() : 'N/A';
    const age = live.anchor ? Math.max(0, Math.round((Date.now() - live.anchor) / 1000)) : null;
    $('market-last-update').textContent = `Last update: ${received}${age == null ? '' : ` (${age}s ago)`}${live.tickTime ? ` · last tick ${new Date(live.tickTime).toLocaleTimeString()}` : ''}`;
  }

  function applySummary(summary) {
    state.summary = summary;
    const live = state.live;
    state.stats = { previousClose: summary.previousClose, dayOpen: summary.dayOpen, dayHigh: summary.dayHigh, dayLow: summary.dayLow };
    $('market-quote-symbol').textContent = summary.symbol;
    $('market-quote-label').textContent = summary.label;
    $('info-open').textContent = summary.dayOpen == null ? 'N/A' : formatPrice(summary.dayOpen);
    $('info-high').textContent = summary.dayHigh == null ? 'N/A' : formatPrice(summary.dayHigh);
    $('info-low').textContent = summary.dayLow == null ? 'N/A' : formatPrice(summary.dayLow);
    $('info-prev-close').textContent = summary.previousClose == null ? 'N/A' : formatPrice(summary.previousClose);
    $('market-attribution').textContent = summary.attribution || '';
    const note = $('market-instrument-note');
    if (summary.instrumentNote) { note.textContent = summary.instrumentNote; note.hidden = false; }
    else note.hidden = true;

    if (summary.source && summary.source.kind === 'corngrid-ea') {
      Object.assign(live, {
        source: 'corngrid-ea', feed: summary.source.feed, brokerSymbol: summary.brokerSymbol,
        bid: summary.bid, ask: summary.ask, spread: summary.spread, spreadPoints: summary.spreadPoints, digits: summary.digits,
        state: summary.state, quiet: Boolean(summary.quiet), limits: summary.limits,
        anchor: Date.now() - (summary.ageMs || 0), receivedMs: summary.lastUpdate ? Date.parse(summary.lastUpdate) : 0,
        rev: summary.rev || 0, tickTime: summary.tickTime, offset: summary.serverUtcOffsetSec
      });
      renderLive();
      return;
    }
    // Fallback provider data: always labeled, never presented as the CornGrid EA broker feed.
    stopLive();
    Object.assign(live, { source: 'fallback', state: 'FALLBACK', bid: null, ask: null, feed: null });
    $('market-price').textContent = formatPrice(summary.price);
    $('market-price').classList.remove('muted');
    $('market-quote-meta').textContent = 'Bid/Ask not available from the fallback provider';
    $('info-bid').textContent = 'N/A';
    $('info-ask').textContent = 'N/A';
    $('info-spread').textContent = 'N/A';
    $('info-close').textContent = formatPrice(summary.price);
    renderChange(summary.change, summary.changePercent);
    setConnState('FALLBACK', summary.provider || 'external provider');
    $('market-source').textContent = `Source: ${summary.source ? summary.source.label : (summary.provider || 'external provider')} — not the CornGrid EA broker feed`;
    $('market-last-update').textContent = `Last update: ${summary.lastUpdate ? new Date(summary.lastUpdate).toLocaleString() : 'N/A'}`;
  }

  async function loadSummary(silent = false) {
    const symbol = state.symbol;
    try {
      const summary = await request(`/market/summary?symbol=${encodeURIComponent(symbol)}`);
      if (symbol !== state.symbol) return;
      applySummary(summary);
      if (summary.source && summary.source.kind === 'corngrid-ea') startLive();
    } catch (error) {
      if (symbol !== state.symbol) return;
      const live = state.live;
      const unavailable = error.data && error.data.state === 'OFFLINE';
      // A transient error must not wipe an EA feed that is still streaming.
      if (!unavailable && live.source === 'corngrid-ea') {
        if (!silent && state.loaded) toast(error.message, 'error');
        return;
      }
      Object.assign(live, { source: unavailable ? 'none' : live.source, state: 'OFFLINE', bid: null, ask: null });
      stopLive();
      $('market-price').textContent = '—';
      $('market-quote-meta').textContent = 'Bid — · Ask — · Spread —';
      renderChange(null, null);
      setConnState('OFFLINE', unavailable ? 'no feed' : 'unavailable');
      $('market-source').textContent = unavailable ? 'Source: none — CornGrid EA is not publishing and no fallback is enabled.' : `Source: unavailable (${error.message})`;
      $('market-last-update').textContent = 'Last update: N/A';
      if (!silent && state.loaded && !unavailable) toast(error.message, 'error');
    }
  }

  // ---- live updates: Server-Sent Events first, HTTP polling when streaming is unavailable ----
  function stopLive() {
    const live = state.live;
    if (live.es) { live.es.close(); live.es = null; }
    if (live.pollTimer) { clearInterval(live.pollTimer); live.pollTimer = null; }
    if (live.guardTimer) { clearTimeout(live.guardTimer); live.guardTimer = null; }
    live.polling = false;
  }

  function startPolling() {
    const live = state.live;
    if (live.pollTimer) return;
    const symbol = state.symbol;
    const pollOnce = async () => {
      if (live.polling || document.hidden || symbol !== state.symbol) return;
      live.polling = true;
      try {
        const data = await request(`/market/quote?symbol=${encodeURIComponent(symbol)}`);
        if (data.quote) applyQuote(data.quote);
      } catch { /* the watchdog downgrades the state if updates stop */ }
      live.polling = false;
    };
    live.pollTimer = setInterval(pollOnce, 2500);
    pollOnce();
  }

  function startLive() {
    const live = state.live;
    if (!state.pageOpen || document.hidden || live.es || live.pollTimer) return;
    if (!window.EventSource) { startPolling(); return; }
    const symbol = state.symbol;
    let received = false;
    let errors = 0;
    const source = new EventSource(`${API}/market/stream?symbol=${encodeURIComponent(symbol)}`, { withCredentials: true });
    live.es = source;
    const fallToPolling = () => { if (live.es === source) { source.close(); live.es = null; } startPolling(); };
    // Reverse proxies that buffer responses never deliver events; poll instead.
    live.guardTimer = setTimeout(() => { if (!received) fallToPolling(); }, 8000);
    const onFrame = event => {
      received = true;
      errors = 0;
      if (symbol !== state.symbol) return;
      try { applyQuote(JSON.parse(event.data)); } catch { /* ignore malformed frame */ }
    };
    source.addEventListener('snapshot', onFrame);
    source.addEventListener('quote', onFrame);
    source.addEventListener('bye', () => { source.close(); if (live.es === source) live.es = null; window.setTimeout(startLive, 500); });
    source.onerror = () => {
      errors += 1;
      if (source.readyState === EventSource.CLOSED || errors >= 4) fallToPolling();
    };
  }

  function applyQuote(quote) {
    const live = state.live;
    if (!quote || quote.symbol !== state.symbol || live.source !== 'corngrid-ea') return;
    if (quote.bid == null) {
      live.state = 'OFFLINE';
      renderLive();
      return;
    }
    const feedId = quote.feed && quote.feed.id;
    if (live.feed && feedId && feedId !== live.feed) {
      // The server switched to a different broker feed; reload so the chart never mixes feeds.
      live.feed = feedId;
      loadSummary(true);
      loadCandles();
      return;
    }
    const receivedMs = Date.parse(quote.receivedAt);
    if (live.receivedMs && (receivedMs < live.receivedMs || (receivedMs === live.receivedMs && quote.rev < live.rev))) return;
    Object.assign(live, {
      bid: quote.bid, ask: quote.ask, spread: quote.spread, spreadPoints: quote.spreadPoints, digits: quote.digits ?? live.digits,
      state: quote.state, quiet: Boolean(quote.quiet), limits: quote.limits || live.limits, brokerSymbol: quote.brokerSymbol || live.brokerSymbol,
      anchor: Date.now() - (quote.ageMs || 0), receivedMs, rev: quote.rev || 0, tickTime: quote.tickTime,
      offset: quote.serverUtcOffsetSec ?? live.offset
    });
    if (quote.state === 'LIVE' || quote.state === 'DELAYED') updateLiveCandle(quote);
    renderLive();
  }

  // Applies a broker tick to the forming candle in place (zoom and crosshair are untouched).
  // The EA's periodic candle refresh remains the authoritative correction.
  function updateLiveCandle(quote) {
    const last = state.lastCandle;
    if (state.candleSource !== 'corngrid-ea' || !state.candleSeries || !last) return;
    const seconds = TF_SECONDS[state.interval];
    // Candle times are broker server time; shift the UTC tick time onto the same basis.
    const offset = state.live.offset;
    const tickSeconds = Math.floor(Date.parse(quote.tickTime) / 1000) + (Number.isInteger(offset) ? offset : NaN);
    if (!seconds || !Number.isFinite(tickSeconds) || tickSeconds < last.time) return;
    let candle;
    if (tickSeconds < last.time + seconds) {
      candle = { ...last, high: Math.max(last.high, quote.bid), low: Math.min(last.low, quote.bid), close: quote.bid };
    } else if (seconds <= 3600) {
      const bucket = last.time + Math.floor((tickSeconds - last.time) / seconds) * seconds;
      candle = { time: bucket, open: quote.bid, high: quote.bid, low: quote.bid, close: quote.bid, volume: null };
    } else {
      return;
    }
    state.candleSeries.update({ time: candle.time, open: candle.open, high: candle.high, low: candle.low, close: candle.close });
    state.lastCandle = candle;
    if (!state.hovering) renderOhlc(candle);
  }

  // Pulls the newest candles so corrected/closed bars replace the tick-built ones.
  async function refreshTail() {
    const { symbol, interval } = state;
    if (state.candleSource !== 'corngrid-ea' || !state.candleSeries || !state.lastCandle) return;
    try {
      const payload = await request(`/market/candles?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&outputsize=20`);
      if (symbol !== state.symbol || interval !== state.interval || !state.candleSeries || !state.lastCandle) return;
      if (!payload.source || payload.source.kind !== 'corngrid-ea') return;
      for (const candle of payload.candles) {
        if (candle.time < state.lastCandle.time) continue;
        state.candleSeries.update({ time: candle.time, open: candle.open, high: candle.high, low: candle.low, close: candle.close });
        if (state.volumeSeries && candle.volume) {
          state.volumeSeries.update({ time: candle.time, value: candle.volume, color: candle.close >= candle.open ? 'rgba(35,207,139,.35)' : 'rgba(255,115,125,.35)' });
        }
        state.lastCandle = candle;
      }
      if (!state.hovering) renderOhlc(state.lastCandle);
    } catch { /* keep the current chart; state pill reflects feed health */ }
  }

  function watchdog() {
    if (!state.pageOpen || document.hidden) return;
    state.watchdogTicks += 1;
    const live = state.live;
    if (live.source === 'corngrid-ea') {
      renderLive();
      if (state.watchdogTicks % 20 === 0) refreshTail();
    }
    // When no EA feed is active, keep probing so recovery is picked up without a page refresh.
    const healthy = live.source === 'corngrid-ea' && (localState() === 'LIVE' || localState() === 'DELAYED');
    if (!healthy && state.watchdogTicks % 15 === 0) loadSummary(true);
  }

  function onVisibilityChange() {
    if (!state.pageOpen) return;
    if (document.hidden) { stopLive(); return; }
    loadSummary(true);
    loadCandles();
  }

  async function loadCandles() {
    const seq = ++state.requestSeq;
    setChartState('loading');
    try {
      const payload = await request(`/market/candles?symbol=${encodeURIComponent(state.symbol)}&interval=${encodeURIComponent(state.interval)}&outputsize=500`);
      if (seq !== state.requestSeq) return;
      ensureChart();
      if (!state.chart) throw new Error('The chart library failed to load.');
      if (!payload.candles.length) {
        setChartState('empty', 'No candles are available for this symbol and timeframe.');
        return;
      }
      state.candleSeries.setData(payload.candles);
      state.candleSource = payload.source ? payload.source.kind : null;
      state.lastCandle = payload.candles[payload.candles.length - 1];
      renderOhlc(state.lastCandle);
      // Genuine volume data only: hide the histogram when the provider reports none (e.g. FX).
      const hasVolume = payload.candles.some(candle => Number.isFinite(candle.volume) && candle.volume > 0);
      if (hasVolume && !state.volumeSeries) {
        state.volumeSeries = state.chart.addHistogramSeries({
          priceFormat: { type: 'volume' },
          priceScaleId: 'volume',
          lastValueVisible: false,
          priceLineVisible: false
        });
        state.chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      }
      if (state.volumeSeries) {
        state.volumeSeries.setData(hasVolume
          ? payload.candles.map(candle => ({
              time: candle.time,
              value: candle.volume || 0,
              color: candle.close >= candle.open ? 'rgba(35,207,139,.35)' : 'rgba(255,115,125,.35)'
            }))
          : []);
      }
      state.chart.timeScale().fitContent();
      // The series was just re-filled, so every price line drawn on the old data
      // must be removed first. Re-adding them without clearing would stack a new
      // line on every timeframe change and leave the previous ones behind as
      // orphans that the delete button can no longer remove.
      clearChartPriceLines();
      // Restore this symbol's saved drawings onto the fresh series.
      state.drawings.forEach(addDrawingToChart);
      setChartState('hidden');
      state.loaded = true;
    } catch (error) {
      if (seq !== state.requestSeq) return;
      setChartState('error', error.message);
    }
  }



  async function loadDrawings() {
    // Drop the chart-side drawings of the previous symbol before loading the new set.
    // Trend lines are re-rendered from state, so only the price lines need removing.
    clearChartPriceLines();
    try {
      const payload = await request(`/market/drawings?symbol=${encodeURIComponent(state.symbol)}`);
      // Normalise the id to a number so it matches the id used by the price-line
      // map and by the delete button.
      state.drawings = (Array.isArray(payload.drawings) ? payload.drawings : [])
        .map(drawing => ({ ...drawing, id: Number(drawing.id) }));
    } catch (error) {
      state.drawings = [];
      toast(error.message, 'error');
    }
    renderDrawingsList();
    // Apply only the drawings that are not on the chart yet. loadCandles() may
    // already have applied them; adding them twice would stack duplicate lines.
    if (state.candleSeries) state.drawings.forEach(addDrawingToChart);
  }

  async function saveDrawing(kind, data) {
    try {
      const created = await request('/market/drawings', {
        method: 'POST',
        body: JSON.stringify({ symbol: state.symbol, kind, data })
      });
      // The server returns a numeric id; keep the same type everywhere so the
      // price-line map and the saved-drawings list agree on the key.
      const drawing = { id: Number(created.id), kind, data };
      state.drawings.push(drawing);
      addDrawingToChart(drawing);
      renderDrawingsList();
      toast('Drawing saved to your account.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function removeDrawing(id) {
    const drawing = state.drawings.find(item => item.id === id);
    if (!drawing) return;
    try {
      await request(`/market/drawings/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (error) {
      toast(error.message, 'error');
      return;
    }
    // The drawing leaves the state first, so the re-render inside
    // removeDrawingFromChart no longer paints the line that is being deleted.
    state.drawings = state.drawings.filter(item => item.id !== id);
    removeDrawingFromChart(drawing);
    renderDrawingsList();
  }

  function setTool(tool) {
    state.activeTool = state.activeTool === tool ? null : tool;
    state.trendStart = null;
    $('market-tool-hline').classList.toggle('is-active', state.activeTool === 'hline');
    $('market-tool-trend').classList.toggle('is-active', state.activeTool === 'trend');
    const hint = $('market-drawing-hint');
    if (state.activeTool === 'hline') hint.textContent = 'Horizontal line tool: click or tap the chart to place a price level.';
    else if (state.activeTool === 'trend') hint.textContent = state.trendStart
      ? 'Trend tool: place the second point.'
      : 'Trend tool: place the first point, then the second.';
    else hint.textContent = 'Tip: pick a tool, then tap or click the chart to place a level.';
    if (state.chart) {
      // Keep chart dragging/zooming available while the tool is inactive.
      state.chart.applyOptions({ handleScroll: !state.activeTool, handleScale: !state.activeTool });
    }
  }

  function handleChartClick(param) {
    if (!state.activeTool || !param || !param.point || !state.chart) return;
    const price = state.candleSeries.coordinateToPrice(param.point.y);
    if (!Number.isFinite(price)) return;
    if (state.activeTool === 'hline') {
      saveDrawing('hline', { price });
      setTool('hline'); // toggle back off after a single placement
      return;
    }
    if (state.activeTool === 'trend') {
      const time = param.time;
      if (!Number.isFinite(time)) return;
      if (!state.trendStart) {
        state.trendStart = { time, price };
        $('market-drawing-hint').textContent = `First point ${formatPrice(price)} set. Tap the chart for the second point.`;
        return;
      }
      const points = [state.trendStart, { time, price }];
      state.trendStart = null;
      saveDrawing('trend', { points });
      setTool('trend');
    }
  }

  function clearAllDrawings() {
    if (!state.drawings.length) return toast('There are no drawings to clear.');
    if (!window.confirm(`Remove all ${state.drawings.length} drawing(s) on ${state.symbol}?`)) return;
    Promise.all(state.drawings.map(drawing => removeDrawing(drawing.id)))
      .then(() => toast('All drawings removed.', 'success'));
  }


  function zoomChart(factor) {
    if (!state.chart) return;
    const timeScale = state.chart.timeScale();
    const range = timeScale.getVisibleLogicalRange();
    if (!range) return;
    const center = (range.from + range.to) / 2;
    const halfSpan = ((range.to - range.from) / 2) * factor;
    timeScale.setVisibleLogicalRange({ from: center - halfSpan, to: center + halfSpan });
  }

  function resetView() {
    if (state.chart) state.chart.timeScale().fitContent();
  }

  function toggleFullscreen() {
    const wrap = $('market-chart-wrap');
    if (!wrap) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (wrap.requestFullscreen) wrap.requestFullscreen().catch(() => toast('Fullscreen is not available in this browser.', 'error'));
    else toast('Fullscreen is not supported on this device.', 'error');
  }

  function selectSymbol(symbol) {
    if (!symbol || symbol === state.symbol) return;
    state.symbol = symbol;
    stopLive();
    Object.assign(state.live, { source: null, feed: null, bid: null, ask: null, receivedMs: 0, rev: 0, anchor: 0, state: 'OFFLINE' });
    state.candleSource = null;
    state.lastCandle = null;
    state.stats = null;
    document.querySelectorAll('.market-symbol').forEach(button => {
      const active = button.dataset.marketSymbol === symbol;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    loadSummary();
    loadCandles();
    loadDrawings();
  }

  function selectInterval(interval) {
    if (!interval || interval === state.interval) return;
    state.interval = interval;
    state.candleSource = null;
    document.querySelectorAll('.market-tf').forEach(button => {
      button.classList.toggle('is-active', button.dataset.tf === interval);
    });
    loadCandles();
  }

  function bindEvents() {
    document.querySelectorAll('.market-symbol').forEach(button => {
      button.addEventListener('click', () => selectSymbol(button.dataset.marketSymbol));
    });
    document.querySelectorAll('.market-tf').forEach(button => {
      button.addEventListener('click', () => selectInterval(button.dataset.tf));
    });
    $('market-tool-hline').addEventListener('click', () => setTool('hline'));
    $('market-tool-trend').addEventListener('click', () => setTool('trend'));
    $('market-clear-drawings').addEventListener('click', clearAllDrawings);
    $('market-zoom-in').addEventListener('click', () => zoomChart(0.7));
    $('market-zoom-out').addEventListener('click', () => zoomChart(1.4));
    $('market-reset-view').addEventListener('click', resetView);
    $('market-fullscreen').addEventListener('click', toggleFullscreen);
  }

  let eventsBound = false;

  function destroy() {
    // Release chart resources and observers when the dashboard page unloads.
    stopLive();
    if (state.watchdogTimer) { clearInterval(state.watchdogTimer); state.watchdogTimer = null; }
    state.pageOpen = false;
    if (state.resizeObserver) { state.resizeObserver.disconnect(); state.resizeObserver = null; }
    // Remove the trend overlay from the DOM as well; leaving it behind would
    // stack a second overlay on top of the chart the next time it is created.
    if (state.trendOverlay && state.trendOverlay.parentNode) state.trendOverlay.parentNode.removeChild(state.trendOverlay);
    if (state.chart) { state.chart.remove(); state.chart = null; }
    state.candleSeries = null;
    state.volumeSeries = null;
    state.trendOverlay = null;
    state.priceLines.clear();
    state.drawings = [];
    state.activeTool = null;
    state.trendStart = null;
    state.loaded = false;
    state.chartClickBound = false;
    state.requestSeq += 1;
  }

  window.CornGridMarket = {
    onOpen() {
      state.pageOpen = true;
      if (!state.watchdogTimer) state.watchdogTimer = setInterval(watchdog, 1000);
      if (!eventsBound) { bindEvents(); document.addEventListener('visibilitychange', onVisibilityChange); eventsBound = true; }
      // First open: load data; later opens: only refresh if data is already present.
      ensureChart();
      if (state.chart && state.chartClickBound !== true) {
        state.chart.subscribeClick(handleChartClick);
        state.chartClickBound = true;
      }
      loadSummary();
      loadCandles();
      loadDrawings();
    },
    onClose() {
      // Leaving the Market page: stop streaming and timers so nothing runs in the background.
      state.pageOpen = false;
      stopLive();
      if (state.watchdogTimer) { clearInterval(state.watchdogTimer); state.watchdogTimer = null; }
    },
    destroy
  };

  window.addEventListener('pagehide', destroy);
})();

