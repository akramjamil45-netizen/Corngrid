(() => {
  // CornGrid Market Overview: candlestick chart, timeframe tools, and per-user drawings.
  // Depends on vendor/lightweight-charts (Apache-2.0, TradingView) and the /api/market endpoints.
  const API = '/api';
  const SYMBOL_LABELS = { XAUUSD: 'Gold / US Dollar', EURUSD: 'Euro / US Dollar', GBPUSD: 'British Pound / US Dollar', USDJPY: 'US Dollar / Japanese Yen' };
  const DECIMALS = { XAUUSD: 2, EURUSD: 5, GBPUSD: 5, USDJPY: 3 };
  const state = {
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
    if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
    return data;
  }

  function decimals() { return DECIMALS[state.symbol] ?? 2; }
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
  function renderTrendLines() {
    const overlay = state.trendOverlay;
    if (!overlay || !state.chart) return;
    overlay.innerHTML = '';
    const wrapRect = $('market-chart-wrap').getBoundingClientRect();
    const scale = state.chart.timeScale();
    const trends = state.drawings.filter(drawing => drawing.kind === 'trend');
    for (const drawing of trends) {
      const points = (drawing.data && drawing.data.points) || [];
      if (points.length !== 2) continue;
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


  async function loadSummary() {
    try {
      const summary = await request(`/market/summary?symbol=${encodeURIComponent(state.symbol)}`);
      state.summary = summary;
      $('market-price').textContent = formatPrice(summary.price);
      const changeEl = $('market-change');
      const sign = summary.change >= 0 ? '+' : '';
      changeEl.textContent = `${sign}${formatPrice(summary.change)} (${sign}${summary.changePercent.toFixed(2)}%)`;
      changeEl.className = `market-change ${summary.change >= 0 ? 'positive' : 'negative'}`;
      $('market-quote-symbol').textContent = summary.symbol;
      $('market-quote-label').textContent = summary.label;
      $('info-open').textContent = formatPrice(summary.dayOpen);
      $('info-high').textContent = formatPrice(summary.dayHigh);
      $('info-low').textContent = formatPrice(summary.dayLow);
      $('info-close').textContent = formatPrice(summary.price);
      $('info-prev-close').textContent = formatPrice(summary.previousClose);
      const infoChange = $('info-change');
      infoChange.textContent = `${sign}${formatPrice(summary.change)} (${sign}${summary.changePercent.toFixed(2)}%)`;
      infoChange.className = summary.change >= 0 ? 'positive' : 'negative';
      $('market-data-status').textContent = `${summary.dataStatus} · ${summary.provider}`;
      $('market-data-status').className = 'pill pill-muted';
      $('market-last-update').textContent = `Last update: ${new Date(summary.lastUpdate).toLocaleString()}`;
      $('market-attribution').textContent = summary.attribution;
      const note = $('market-instrument-note');
      if (summary.instrumentNote) { note.textContent = summary.instrumentNote; note.hidden = false; }
      else note.hidden = true;
    } catch (error) {
      $('market-data-status').textContent = 'Unavailable';
      $('market-data-status').className = 'pill pill-offline';
      if (state.loaded) toast(error.message, 'error');
    }
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
    // Clear chart-side drawings from the previous symbol before loading the new set.
    for (const drawing of state.drawings) removeDrawingFromChart(drawing);
    try {
      const payload = await request(`/market/drawings?symbol=${encodeURIComponent(state.symbol)}`);
      state.drawings = Array.isArray(payload.drawings) ? payload.drawings : [];
    } catch (error) {
      state.drawings = [];
      toast(error.message, 'error');
    }
    renderDrawingsList();
    // Re-apply once candles exist; if the chart is not ready they are applied after loadCandles.
    if (state.candleSeries && state.drawings.length) state.drawings.forEach(addDrawingToChart);
  }

  async function saveDrawing(kind, data) {
    try {
      const created = await request('/market/drawings', {
        method: 'POST',
        body: JSON.stringify({ symbol: state.symbol, kind, data })
      });
      const drawing = { id: created.id, kind, data };
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
    removeDrawingFromChart(drawing);
    state.drawings = state.drawings.filter(item => item.id !== id);
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
    if (state.resizeObserver) { state.resizeObserver.disconnect(); state.resizeObserver = null; }
    if (state.chart) { state.chart.remove(); state.chart = null; }
    state.candleSeries = null;
    state.volumeSeries = null;
    state.trendOverlay = null;
    state.priceLines.clear();
    state.drawings = [];
    state.loaded = false;
    state.chartClickBound = false;
    state.requestSeq += 1;
  }

  window.CornGridMarket = {
    onOpen() {
      if (!eventsBound) { bindEvents(); eventsBound = true; }
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
    destroy
  };

  window.addEventListener('pagehide', destroy);
})();

