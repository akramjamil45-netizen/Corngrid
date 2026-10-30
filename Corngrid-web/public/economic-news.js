(function () {
  'use strict';

  var FALLBACK_TIME_ZONE = 'UTC';
  var POLL_MS = 5 * 60 * 1000;
  var TICK_MS = 1000;
  var ALERT_STORE_KEY = 'corngrid_econ_alerted_v1';
  var RESULT_STORE_KEY = 'corngrid_econ_results_notified_v1';

  var state = {
    events: [],
    filtered: [],
    meta: null,
    timeZone: detectTimeZone(),
    clockOffset: 0,
    bound: false,
    clockTimer: null,
    tickerTimer: null,
    pollTimer: null,
    loaded: false,
    lastActuals: new Map(),
    currentAlertId: null,
    prefs: {
      enabled: true,
      alertWindow: 15,
      browserNotifications: false,
      relevance: 'all'
    },
    filters: {
      range: 'today',
      search: '',
      impact: 'all'
    }
  };

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function detectTimeZone() {
    try {
      return new Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TIME_ZONE;
    } catch (e) {
      return FALLBACK_TIME_ZONE;
    }
  }

  function validTimeZone(value) {
    if (!value || typeof value !== 'string') return null;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return value;
    } catch (e) {
      return null;
    }
  }

  function nowMs() { return Date.now() + state.clockOffset; }

  function dateKeyInZone(ms) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: state.timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(ms));
  }

  function eventDateKey(ev) {
    if (!ev) return null;
    if (ev.startMs != null) return dateKeyInZone(ev.startMs);
    return ev.dateKey || null;
  }

  function timeZoneName(ms) {
    try {
      var parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: state.timeZone, timeZoneName: 'short'
      }).formatToParts(new Date(ms));
      for (var i = 0; i < parts.length; i += 1) {
        if (parts[i].type === 'timeZoneName' && parts[i].value) return parts[i].value;
      }
    } catch (e) { /* fall through */ }
    return state.timeZone;
  }

  function shiftDateKey(key, days) {
    var parts = key.split('-').map(Number);
    var dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }

  function weekRangeKeys(ms) {
    var today = dateKeyInZone(ms);
    var parts = today.split('-').map(Number);
    var dow = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay();
    var backToMonday = (dow + 6) % 7;
    var start = shiftDateKey(today, -backToMonday);
    return { start: start, end: shiftDateKey(start, 6) };
  }

  function sortMs(ev) {
    if (ev.startMs != null) return ev.startMs;
    if (ev.dateKey) return Date.parse(ev.dateKey + 'T00:00:00Z');
    return Number.POSITIVE_INFINITY;
  }

  function formatClock(ms) {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: state.timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      }).format(new Date(ms));
    } catch (e) { return '--:--:--'; }
  }

  function formatCountdown(diffMs) {
    var total = Math.floor(diffMs / 1000);
    var d = Math.floor(total / 86400); total -= d * 86400;
    var h = Math.floor(total / 3600); total -= h * 3600;
    var m = Math.floor(total / 60);
    var s = total - m * 60;
    function pad(n) { return String(n).padStart(2, '0'); }
    if (d > 0) return pad(d) + 'd ' + pad(h) + 'h ' + pad(m) + 'm';
    return pad(h) + 'h ' + pad(m) + 'm ' + pad(s) + 's';
  }

  function parseNumeric(value) {
    if (value == null) return null;
    var m = String(value).replace(/,/g, '').match(/^([+-]?\d*\.?\d+)\s*([%a-zA-Z]*)$/);
    if (!m) return null;
    var n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    return { n: n, unit: (m[2] || '').toUpperCase() };
  }

  function compareToForecast(ev) {
    var a = parseNumeric(ev.actual);
    var f = parseNumeric(ev.forecast);
    if (!a || !f || a.unit !== f.unit) return 'none';
    if (Math.abs(a.n - f.n) < 1e-9) return 'inline';
    return a.n > f.n ? 'above' : 'below';
  }

  function released(ev) { return ev.actual != null || ev.revised != null; }

  function statusFor(ev) {
    var now = nowMs();
    if (ev.startMs == null) return { key: 'unknown', label: 'TIME N/A', tone: 'status-past' };
    // A published result always wins over the time slot, even when released early.
    if (released(ev)) return { key: 'released', label: 'RELEASED', tone: 'status-released' };
    var diff = ev.startMs - now;
    if (diff > 0) {
      if (diff <= 5 * 60 * 1000) return { key: 'imminent', label: 'IMMINENT', tone: 'status-soon' };
      if (diff <= 60 * 60 * 1000) return { key: 'approaching', label: 'APPROACHING', tone: 'status-soon' };
      return { key: 'upcoming', label: 'UPCOMING', tone: 'status-upcoming' };
    }
    return { key: 'waiting', label: 'WAITING FOR RESULT', tone: 'status-past' };
  }

  function countdownLabel(ev) {
    if (ev.startMs == null) return 'N/A';
    if (released(ev)) return 'Released';
    var diff = ev.startMs - nowMs();
    if (diff <= 0) return 'Awaiting result';
    if (diff <= 60 * 1000) return 'Releasing soon';
    return formatCountdown(diff);
  }

  function impactClass(imp) {
    if (imp === 'high') return 'impact-high';
    if (imp === 'medium') return 'impact-med';
    if (imp === 'holiday') return 'impact-holiday';
    return 'impact-low';
  }

  function impactLabel(imp) {
    if (imp === 'high') return 'HIGH';
    if (imp === 'medium') return 'MED';
    if (imp === 'holiday') return 'HOLIDAY';
    if (imp === 'unknown') return 'N/A';
    return 'LOW';
  }

  function safeUrl(url) {
    if (!url) return null;
    try {
      var u = new URL(url);
      if (u.protocol !== 'https:') return null;
      if (u.hostname !== 'www.forexfactory.com' && u.hostname !== 'forexfactory.com') return null;
      return u.toString();
    } catch (e) { return null; }
  }

  function loadStore(key) {
    try {
      var raw = sessionStorage.getItem(key);
      var parsed = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch (e) { return new Set(); }
  }

  function saveStore(key, set) {
    try { sessionStorage.setItem(key, JSON.stringify(Array.prototype.slice.call(set))); } catch (e) { /* ignore */ }
  }

  var alerted = loadStore(ALERT_STORE_KEY);
  var resultsNotified = loadStore(RESULT_STORE_KEY);

  function matchesRange(ev) {
    var range = state.filters.range;
    if (range === 'upcoming') {
      // Released results are no longer upcoming and must never be listed as such.
      if (released(ev)) return false;
      if (ev.startMs != null) return ev.startMs >= nowMs();
      var upcomingKey = eventDateKey(ev);
      return upcomingKey != null && upcomingKey >= dateKeyInZone(nowMs());
    }
    var eventKey = eventDateKey(ev);
    if (!eventKey) return false;
    var today = dateKeyInZone(nowMs());
    if (range === 'today') return eventKey === today;
    if (range === 'tomorrow') return eventKey === shiftDateKey(today, 1);
    if (range === 'week') {
      var w = weekRangeKeys(nowMs());
      return eventKey >= w.start && eventKey <= w.end;
    }
    return true;
  }

  function passesFilters(ev) {
    if (state.filters.impact !== 'all' && ev.impact !== state.filters.impact) return false;
    if (state.filters.search) {
      var q = state.filters.search.toLowerCase();
      var hay = ((ev.title || '') + ' ' + (ev.currency || '') + ' ' + (ev.impact || '')).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return matchesRange(ev);
  }

  function cell(content, cls) {
    var span = document.createElement('span');
    span.setAttribute('role', 'cell');
    if (cls) span.className = cls;
    if (content != null) span.textContent = content;
    return span;
  }

  function buildRow(ev) {
    var row = document.createElement('div');
    row.className = 'econ-row';
    row.setAttribute('role', 'row');
    row.dataset.eventId = ev.id;
    if (ev.startMs != null) row.dataset.startMs = String(ev.startMs);

    var timeCell = cell(null, 'econ-time-cell');
    timeCell.dataset.label = 'Time (' + timeZoneName(ev.startMs != null ? ev.startMs : nowMs()) + ')';
    var timeText = document.createElement('span');
    if (ev.startMs != null) {
      timeText.textContent = formatClock(ev.startMs);
    } else {
      timeText.textContent = eventDateKey(ev) || 'TIME N/A';
      timeText.className = 'muted';
    }
    timeCell.appendChild(timeText);
    if (ev.startMs != null) {
      var dateSub = document.createElement('span');
      dateSub.className = 'muted small';
      dateSub.textContent = eventDateKey(ev);
      timeCell.appendChild(dateSub);
    }
    row.appendChild(timeCell);

    var curCell = cell(null);
    curCell.dataset.label = 'Currency';
    var cur = document.createElement('span');
    cur.className = 'econ-cur';
    cur.textContent = ev.currency || 'ALL';
    curCell.appendChild(cur);
    row.appendChild(curCell);

    var impCell = cell(null);
    impCell.dataset.label = 'Impact';
    var imp = document.createElement('span');
    imp.className = 'econ-impact ' + impactClass(ev.impact);
    imp.textContent = impactLabel(ev.impact);
    impCell.appendChild(imp);
    row.appendChild(impCell);

    var titleCell = cell(null);
    titleCell.dataset.label = 'Event';
    var titleWrap = document.createElement('div');
    titleWrap.className = 'econ-title';
    var titleText = document.createElement('span');
    titleText.textContent = ev.title || '';
    titleWrap.appendChild(titleText);
    var link = safeUrl(ev.url);
    if (link) {
      var a = document.createElement('a');
      a.className = 'econ-link';
      a.href = link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = '↗';
      a.setAttribute('aria-label', 'Open Forex Factory event page');
      titleWrap.appendChild(a);
    }
    titleCell.appendChild(titleWrap);
    row.appendChild(titleCell);

    var cmp = compareToForecast(ev);
    var actualCell = cell(null, 'econ-actual-cell econ-col-num');
    actualCell.dataset.label = 'Actual';
    actualCell.dataset.compare = cmp;
    actualCell.textContent = ev.actual != null ? ev.actual : 'N/A';
    if (ev.actual == null) actualCell.classList.add('muted');
    row.appendChild(actualCell);

    var forecastCell = cell(ev.forecast != null ? ev.forecast : 'N/A', (ev.forecast == null ? 'muted' : '') + ' econ-col-num');
    forecastCell.dataset.label = 'Forecast';
    row.appendChild(forecastCell);
    var prevCell = cell(null, 'econ-col-num');
    prevCell.dataset.label = 'Previous';
    prevCell.textContent = ev.previous != null ? ev.previous : 'N/A';
    if (ev.previous == null) prevCell.classList.add('muted');
    if (ev.revised != null) {
      var rev = document.createElement('span');
      rev.className = 'muted small';
      rev.textContent = 'revised ' + ev.revised;
      prevCell.appendChild(rev);
    }
    row.appendChild(prevCell);

    var statusCell = cell(null, 'econ-status-cell');
    statusCell.dataset.label = 'Status';
    var badge = document.createElement('span');
    var st = statusFor(ev);
    badge.className = 'econ-status ' + st.tone;
    badge.textContent = st.label;
    statusCell.appendChild(badge);
    var cd = document.createElement('span');
    cd.className = 'muted small econ-countdown';
    cd.textContent = countdownLabel(ev);
    cd.setAttribute('aria-hidden', 'true');
    statusCell.appendChild(cd);
    row.appendChild(statusCell);

    return row;
  }

  // Mobile counterpart of buildRow: the same data presented as a card so the
  // table never has to be compressed on narrow screens.
  function buildCard(ev) {
    var card = document.createElement('article');
    card.className = 'econ-card';
    card.setAttribute('role', 'listitem');
    card.dataset.eventId = ev.id;
    if (ev.startMs != null) card.dataset.startMs = String(ev.startMs);

    var head = document.createElement('div');
    head.className = 'econ-card-head';

    var time = document.createElement('div');
    time.className = 'econ-card-time';
    var timeText = document.createElement('span');
    if (ev.startMs != null) timeText.textContent = formatClock(ev.startMs);
    else {
      timeText.textContent = eventDateKey(ev) || 'TIME N/A';
      timeText.className = 'muted';
    }
    time.appendChild(timeText);
    if (ev.startMs != null) {
      var dateSub = document.createElement('small');
      dateSub.textContent = eventDateKey(ev);
      time.appendChild(dateSub);
    }
    head.appendChild(time);

    var tags = document.createElement('div');
    tags.className = 'econ-card-tags';
    var cur = document.createElement('span');
    cur.className = 'econ-cur';
    cur.textContent = ev.currency || 'ALL';
    tags.appendChild(cur);
    var imp = document.createElement('span');
    imp.className = 'econ-impact ' + impactClass(ev.impact);
    imp.textContent = impactLabel(ev.impact);
    tags.appendChild(imp);
    head.appendChild(tags);
    card.appendChild(head);

    var title = document.createElement('div');
    title.className = 'econ-card-title';
    title.appendChild(document.createTextNode(ev.title || ''));
    var link = safeUrl(ev.url);
    if (link) {
      var a = document.createElement('a');
      a.className = 'econ-card-link';
      a.href = link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = ' ↗';
      a.setAttribute('aria-label', 'Open Forex Factory event page');
      title.appendChild(a);
    }
    card.appendChild(title);

    var values = document.createElement('div');
    values.className = 'econ-card-values';
    var actual = document.createElement('div');
    actual.className = 'econ-card-value' + (ev.actual == null ? ' is-muted' : ' is-actual');
    actual.appendChild(valueLabel('Actual'));
    actual.appendChild(valueText(ev.actual == null ? 'N/A' : ev.actual));
    values.appendChild(actual);
    values.appendChild(valueBox('Forecast', ev.forecast == null ? 'N/A' : ev.forecast, ev.forecast == null));
    var prevBox = valueBox('Previous', ev.previous == null ? 'N/A' : ev.previous, ev.previous == null);
    if (ev.revised != null) {
      var rev = document.createElement('span');
      rev.className = 'muted';
      rev.textContent = 'revised ' + ev.revised;
      prevBox.appendChild(rev);
    }
    values.appendChild(prevBox);
    card.appendChild(values);

    var foot = document.createElement('div');
    foot.className = 'econ-card-foot';
    var badge = document.createElement('span');
    var st = statusFor(ev);
    badge.className = 'econ-status ' + st.tone;
    badge.textContent = st.label;
    foot.appendChild(badge);
    var cd = document.createElement('span');
    cd.className = 'econ-card-countdown';
    cd.textContent = countdownLabel(ev);
    foot.appendChild(cd);
    card.appendChild(foot);

    return card;
  }

  function valueLabel(text) {
    var el = document.createElement('span');
    el.textContent = text;
    return el;
  }

  function valueText(text) {
    var el = document.createElement('strong');
    el.textContent = text;
    return el;
  }

  function valueBox(label, text, muted) {
    var box = document.createElement('div');
    box.className = 'econ-card-value' + (muted ? ' is-muted' : '');
    box.appendChild(valueLabel(label));
    box.appendChild(valueText(text));
    return box;
  }

  function renderRows() {
    var host = $('#econ-rows');
    var cardHost = $('#econ-cards');
    if (host) host.textContent = '';
    if (cardHost) cardHost.textContent = '';
    state.filtered = state.events.filter(passesFilters).sort(function (a, b) { return sortMs(a) - sortMs(b); });

    var count = $('#econ-event-count');
    if (count) count.textContent = state.filtered.length + (state.filtered.length === 1 ? ' event' : ' events');

    var empty = $('#econ-empty');
    var table = $('#econ-table');
    if (state.filtered.length === 0) {
      if (empty) empty.hidden = false;
      if (table) table.style.display = 'none';
      if (cardHost) cardHost.style.display = 'none';
      return;
    }
    if (empty) empty.hidden = true;
    if (table) table.style.display = '';
    if (cardHost) cardHost.style.display = '';

    var frag = document.createDocumentFragment();
    var cardFrag = document.createDocumentFragment();
    for (var i = 0; i < state.filtered.length && i < 400; i += 1) {
      frag.appendChild(buildRow(state.filtered[i]));
      cardFrag.appendChild(buildCard(state.filtered[i]));
    }
    if (host) host.appendChild(frag);
    if (cardHost) cardHost.appendChild(cardFrag);
  }

  function tickCountdowns() {
    var rows = $$('.econ-row, .econ-card');
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      var startMs = row.dataset.startMs ? Number(row.dataset.startMs) : null;
      if (startMs == null) continue;
      var ev = null;
      for (var j = 0; j < state.events.length; j += 1) {
        if (state.events[j].id === row.dataset.eventId) { ev = state.events[j]; break; }
      }
      if (!ev) continue;
      var diff = startMs - nowMs();
      var cd = $('.econ-countdown', row) || $('.econ-card-countdown', row);
      if (cd) cd.textContent = diff > 0 ? (diff <= 60000 ? 'Releasing soon' : formatCountdown(diff)) : (released(ev) ? 'Released' : 'Awaiting result');
      var badge = $('.econ-status', row);
      if (badge) {
        var st = statusFor(ev);
        badge.className = 'econ-status ' + st.tone;
        badge.textContent = st.label;
      }
    }
  }

  function updateSummary() {
    var now = nowMs();
    var todayKey = dateKeyInZone(now);
    var highToday = 0, highUpcoming = 0, releasedCount = 0, nextHigh = null;

    for (var i = 0; i < state.events.length; i += 1) {
      var ev = state.events[i];
      if (ev.impact === 'high') {
        if (eventDateKey(ev) === todayKey) highToday += 1;
        // A released event is never counted as upcoming, even if its slot has passed.
        if (!released(ev) && ev.startMs != null && ev.startMs >= now) {
          highUpcoming += 1;
          if (!nextHigh || ev.startMs < nextHigh.startMs) nextHigh = ev;
        }
      }
      if (released(ev)) releasedCount += 1;
    }

    setText('#econ-stat-high-today', String(highToday));
    setText('#econ-stat-high-upcoming', String(highUpcoming));
    setText('#econ-stat-released', String(releasedCount));

    var nextEl = $('#econ-stat-next');
    var nextLabel = $('#econ-stat-next-label');
    if (nextHigh && nextEl) {
      var diff = nextHigh.startMs - now;
      nextEl.textContent = diff <= 60000 ? 'Releasing soon' : formatCountdown(diff);
      if (nextLabel) {
        var title = nextHigh.title || '';
        nextLabel.textContent = (nextHigh.currency || '') + ' · ' + (title.length > 42 ? title.slice(0, 39) + '…' : title);
      }
    } else {
      if (nextEl) nextEl.textContent = '—';
      if (nextLabel) nextLabel.textContent = 'No upcoming high-impact event';
    }
  }

  function setText(sel, value) {
    var el = $(sel);
    if (el) el.textContent = value;
  }

  function detectNewResults(currentActuals, previousActuals) {
    currentActuals.forEach(function (actual, id) {
      if (actual == null) return;
      var prev = previousActuals.get(id);
      // First sight of an event that already has a result is not a release
      // while the page was open, so it must not notify.
      if (prev === undefined || prev === actual) return;
      var key = id + ':' + actual;
      if (resultsNotified.has(key)) return;
      resultsNotified.add(key);
      saveStore(RESULT_STORE_KEY, resultsNotified);
      var ev = null;
      for (var i = 0; i < state.events.length; i += 1) {
        if (state.events[i].id === id) { ev = state.events[i]; break; }
      }
      if (!ev) return;
      var label = (ev.currency || '') + ' ' + (ev.title || '') + ' = ' + actual;
      var message = (prev === null || prev === '') ? 'Result released: ' + label : 'Result revised: ' + label;
      toast(message, 'success');
      notifyBrowser(prev === null || prev === '' ? 'Result released' : 'Result revised', label);
    });
  }

  function activeAlert(now) {
    if (!state.prefs.enabled) return null;
    var windowMs = (state.prefs.alertWindow || 15) * 60 * 1000;
    var best = null;
    for (var i = 0; i < state.events.length; i += 1) {
      var ev = state.events[i];
      if (ev.impact !== 'high' || ev.startMs == null) continue;
      // A released event is never a valid alert target.
      if (released(ev)) continue;
      if (state.prefs.relevance !== 'all' && (ev.relevance || []).indexOf(state.prefs.relevance) === -1) continue;
      var diff = ev.startMs - now;
      if (diff <= 0 || diff > windowMs) continue;
      if (!best || diff < best.diff) best = { ev: ev, diff: diff };
    }
    return best;
  }

  function checkAlerts() {
    var banner = $('#econ-alert-banner');
    if (!banner) return;
    var hit = activeAlert(nowMs());
    if (!hit) {
      if (state.currentAlertId) {
        banner.hidden = true;
        state.currentAlertId = null;
      }
      return;
    }
    var key = hit.ev.id + ':' + state.prefs.alertWindow;
    if (alerted.has(key) && state.currentAlertId !== hit.ev.id) {
      return; // already acknowledged for this window
    }
    if (state.currentAlertId === hit.ev.id) return;
    state.currentAlertId = hit.ev.id;
    var title = $('#econ-alert-title');
    var text = $('#econ-alert-text');
    if (title) title.textContent = 'High-impact in ' + Math.max(1, Math.round(hit.diff / 60000)) + ' min';
    if (text) text.textContent = (hit.ev.currency || '') + ' - ' + hit.ev.title + ' · ' + formatClock(hit.ev.startMs) + ' ' + timeZoneName(hit.ev.startMs);
    banner.hidden = false;
    if (!alerted.has(key)) {
      alerted.add(key);
      saveStore(ALERT_STORE_KEY, alerted);
      notifyBrowser('High-impact event approaching', (hit.ev.currency || '') + ' ' + hit.ev.title + ' at ' + formatClock(hit.ev.startMs) + ' ' + timeZoneName(hit.ev.startMs));
    }
  }

  function toast(message, type) {
    var region = $('#toast-region');
    if (!region) return;
    var item = document.createElement('div');
    item.className = 'toast ' + (type || '');
    item.textContent = message;
    region.appendChild(item);
    window.setTimeout(function () { item.remove(); }, 4500);
  }

  function notifyBrowser(title, body) {
    if (!state.prefs.browserNotifications) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try { new Notification(title, { body: body, tag: 'corngrid-econ' }); } catch (e) { /* ignore */ }
  }

  function applyMeta(meta) {
    state.meta = meta || null;
    var pill = $('#econ-feed-status');
    if (pill && meta) {
      var map = { LIVE: 'pill-live', DELAYED: 'pill-delayed', STALE: 'pill-stale', UNAVAILABLE: 'pill-offline' };
      pill.className = 'pill ' + (map[meta.feedState] || 'pill-muted');
      pill.textContent = meta.feedState || 'UNKNOWN';
    }
    setText('#econ-last-update', meta && meta.fetchedAt ? 'Updated ' + formatClock(meta.fetchedAt) + ' ' + timeZoneName(meta.fetchedAt) : 'Last update: N/A');

    var notice = $('#econ-stale-notice');
    var noticeText = $('#econ-stale-text');
    if (notice) {
      if (meta && meta.stale && meta.error) {
        notice.hidden = false;
        if (noticeText) noticeText.textContent = 'Showing last cached calendar. ' + meta.error;
      } else {
        notice.hidden = true;
      }
    }

    var note = $('#econ-source-note');
    if (note && meta) {
      var parts = ['Source: ' + (meta.source || 'Forex Factory')];
      parts.push('Source TZ: ' + (meta.sourceTimeZone || 'America/New_York'));
      parts.push('Display TZ: ' + state.timeZone + ' (' + timeZoneName(nowMs()) + ')');
      if (meta.actualsPublished === false) {
        parts.push('Note: this feed publishes forecast and previous values; actual results appear only when supplied by Forex Factory.');
      }
      note.textContent = parts.join(' · ');
    }
  }

  function showError(message) {
    var panel = $('#econ-error');
    var text = $('#econ-error-text');
    if (text) text.textContent = message || 'The economic calendar source is temporarily unavailable.';
    if (panel) panel.hidden = false;
    var table = $('#econ-table');
    if (table && state.events.length === 0) table.style.display = 'none';
    var cards = $('#econ-cards');
    if (cards && state.events.length === 0) cards.style.display = 'none';
  }

  function hideError() {
    var panel = $('#econ-error');
    if (panel) panel.hidden = true;
  }

  async function request(path, options) {
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 30000);
    try {
      var res = await fetch(path, Object.assign({ credentials: 'same-origin', signal: controller.signal }, options || {}));
      if (!res.ok) {
        var msg = 'Request failed (' + res.status + ')';
        try { var body = await res.json(); if (body && body.error) msg = body.error; } catch (e) { /* ignore */ }
        throw new Error(msg);
      }
      return res.json();
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('The calendar request timed out. Please check your connection and try again.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Applies a calendar payload once: keeps the actual-result baseline from the
  // previous payload, detects releases/revisions against it, then repaints.
  function applyCalendar(data) {
    if (data.meta && data.meta.fetchedAt) {
      state.clockOffset = data.meta.fetchedAt - Date.now();
    }
    var previousActuals = state.lastActuals;
    var currentActuals = new Map();
    state.events = Array.isArray(data.events) ? data.events : (data.events || state.events);
    for (var i = 0; i < state.events.length; i += 1) {
      currentActuals.set(state.events[i].id, state.events[i].actual == null ? null : state.events[i].actual);
    }
    hideError();
    applyMeta(data.meta);
    renderRows();
    updateSummary();
    if (state.loaded) detectNewResults(currentActuals, previousActuals);
    state.lastActuals = currentActuals;
    state.loaded = true;
    checkAlerts();
  }

  async function fetchCalendar(force) {
    var table = $('#econ-table');
    var rows = $('#econ-rows');
    var cards = $('#econ-cards');
    var error = $('#econ-error');
    if (!state.loaded && table) {
      table.style.display = 'none';
      if (cards) cards.style.display = 'none';
    }
    if (error) error.hidden = true;
    try {
      var url = '/api/economic-calendar' + (force ? '?refresh=1' : '');
      var data = await request(url);
      applyCalendar(data);
      if (table) table.style.display = '';
      if (cards) cards.style.display = '';
    } catch (error) {
      console.warn('Economic calendar request failed:', error.message);
      if (rows) rows.textContent = '';
      if (cards) cards.textContent = '';
      if (table) table.style.display = 'none';
      if (cards) cards.style.display = 'none';
      if (state.events.length === 0) showError(error.message);
      else if (state.meta) {
        state.meta.stale = true;
        state.meta.error = error.message;
        applyMeta(state.meta);
      }
    }
  }

  async function refreshCalendar() {
    var button = $('#econ-refresh');
    if (button) {
      button.classList.add('is-loading');
      button.disabled = true;
    }
    try {
      var data = await request('/api/economic-calendar/refresh', { method: 'POST' });
      applyCalendar(data);
      toast('Calendar refreshed.', 'success');
    } catch (error) {
      toast(error.message || 'The calendar could not be refreshed.', 'error');
    } finally {
      if (button) {
        button.classList.remove('is-loading');
        button.disabled = false;
      }
    }
  }

  async function loadPreferences() {
    var savedTimeZone = null;
    try {
      var data = await request('/api/me');
      savedTimeZone = validTimeZone(data && data.preferences && data.preferences.timezone);
      var saved = data && data.preferences && data.preferences.economicNews;
      if (saved && typeof saved === 'object') {
        if (typeof saved.enabled === 'boolean') state.prefs.enabled = saved.enabled;
        if ([5, 15, 30, 60].indexOf(saved.alertWindow) !== -1) state.prefs.alertWindow = saved.alertWindow;
        if (typeof saved.browserNotifications === 'boolean') state.prefs.browserNotifications = saved.browserNotifications;
        if (['all', 'XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'].indexOf(saved.relevance) !== -1) state.prefs.relevance = saved.relevance;
      }
    } catch (e) { /* keep defaults */ }
    if (savedTimeZone && savedTimeZone !== state.timeZone) {
      state.timeZone = savedTimeZone;
      renderRows();
      updateSummary();
      updateClock();
    }
    syncPreferenceControls();
  }

  function syncPreferenceControls() {
    var enabled = $('#econ-alerts-enabled');
    var browser = $('#econ-browser-notifications');
    var windowSel = $('#econ-alert-window');
    var relevance = $('#econ-relevance-filter');
    if (enabled) enabled.checked = state.prefs.enabled;
    if (browser) browser.checked = state.prefs.browserNotifications;
    if (windowSel) windowSel.value = String(state.prefs.alertWindow);
    if (relevance) relevance.value = state.prefs.relevance;
    var status = $('#econ-notification-status');
    if (status) {
      if (!('Notification' in window)) status.textContent = 'Browser notifications are not supported on this device.';
      else status.textContent = 'Browser notifications: ' + Notification.permission;
    }
  }

  async function savePreferences() {
    try {
      await request('/api/user/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ economicNews: state.prefs })
      });
    } catch (error) {
      toast(error.message || 'Preferences could not be saved.', 'error');
    }
  }

  function bindEvents() {
    if (state.bound) return;
    state.bound = true;

    $$('.econ-filter').forEach(function (btn) {
      btn.addEventListener('click', function () {
        $$('.econ-filter').forEach(function (b) { b.classList.remove('is-active'); b.setAttribute('aria-pressed', 'false'); });
        btn.classList.add('is-active');
        btn.setAttribute('aria-pressed', 'true');
        state.filters.range = btn.dataset.econRange;
        renderRows();
        checkAlerts();
      });
    });

    var search = $('#econ-search');
    if (search) search.addEventListener('input', function () { state.filters.search = search.value.trim(); renderRows(); });

    var impact = $('#econ-impact-filter');
    if (impact) impact.addEventListener('change', function () { state.filters.impact = impact.value; renderRows(); });

    var relevance = $('#econ-relevance-filter');
    if (relevance) relevance.addEventListener('change', function () {
      state.prefs.relevance = relevance.value;
      state.currentAlertId = null;
      savePreferences();
      checkAlerts();
    });

    var refresh = $('#econ-refresh');
    if (refresh) refresh.addEventListener('click', function () { refreshCalendar(); });

    var retry = $('#econ-retry');
    if (retry) retry.addEventListener('click', function () { hideError(); fetchCalendar(true); });

    var reset = $('#econ-empty-reset');
    if (reset) reset.addEventListener('click', function () {
      state.filters = { range: 'today', search: '', impact: 'all' };
      $$('.econ-filter').forEach(function (b) {
        var active = b.dataset.econRange === 'today';
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      if (search) search.value = '';
      if (impact) impact.value = 'all';
      renderRows();
    });

    var dismiss = $('#econ-alert-dismiss');
    if (dismiss) dismiss.addEventListener('click', function () {
      var banner = $('#econ-alert-banner');
      if (banner) banner.hidden = true;
      if (state.currentAlertId) {
        var key = state.currentAlertId + ':' + state.prefs.alertWindow;
        alerted.add(key);
        saveStore(ALERT_STORE_KEY, alerted);
      }
      state.currentAlertId = null;
    });

    var enabled = $('#econ-alerts-enabled');
    if (enabled) enabled.addEventListener('change', function () { state.prefs.enabled = enabled.checked; savePreferences(); });

    var windowSel = $('#econ-alert-window');
    if (windowSel) windowSel.addEventListener('change', function () {
      state.prefs.alertWindow = Number(windowSel.value) || 15;
      state.currentAlertId = null;
      savePreferences();
    });

    var browser = $('#econ-browser-notifications');
    if (browser) browser.addEventListener('change', function () {
      if (browser.checked && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().then(function (perm) {
          state.prefs.browserNotifications = perm === 'granted';
          browser.checked = state.prefs.browserNotifications;
          syncPreferenceControls();
          if (perm !== 'granted') toast('Browser notifications were not granted.', 'error');
          savePreferences();
        });
        return;
      }
      if (browser.checked && 'Notification' in window && Notification.permission === 'denied') {
        browser.checked = false;
        state.prefs.browserNotifications = false;
        toast('Browser notifications are blocked for this site.', 'error');
        savePreferences();
        return;
      }
      state.prefs.browserNotifications = browser.checked;
      savePreferences();
    });
  }

  function updateClock() {
    setText('#econ-clock', formatClock(nowMs()) + ' ' + timeZoneName(nowMs()));
  }

  function startTimers() {
    stopTimers();
    state.clockTimer = window.setInterval(updateClock, TICK_MS);
    updateClock();

    state.tickerTimer = window.setInterval(function () {
      tickCountdowns();
      updateSummary();
      checkAlerts();
    }, TICK_MS);

    state.pollTimer = window.setInterval(function () { fetchCalendar(false); }, POLL_MS);
  }

  function stopTimers() {
    if (state.clockTimer) { window.clearInterval(state.clockTimer); state.clockTimer = null; }
    if (state.tickerTimer) { window.clearInterval(state.tickerTimer); state.tickerTimer = null; }
    if (state.pollTimer) { window.clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  window.CornGridEconomic = {
    onOpen: function () {
      bindEvents();
      loadPreferences();
      fetchCalendar(false);
      startTimers();
    },
    onClose: function () {
      stopTimers();
      state.currentAlertId = null;
      var banner = $('#econ-alert-banner');
      if (banner) banner.hidden = true;
    }
  };
})();
