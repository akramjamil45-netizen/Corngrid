/* CornGrid report canvas components. No remote fonts or third-party renderer. */
(() => {
  'use strict';
  const C = { paper: '#F8F6EF', ink: '#000000', yellow: '#FFEB00', panel: '#1B1B1B', gray: '#777777', muted: '#595959' };
  function format(metric) {
    if (metric.value === null || metric.value === undefined || !Number.isFinite(Number(metric.value))) return 'N/A';
    const n = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(metric.value));
    return metric.unit === 'currency' ? (metric.currency ? `${metric.currency} ${n}` : 'N/A') : metric.unit === 'percent' ? `${n}%` : n;
  }
  function round(ctx, x, y, w, h, color, radius = 24) {
    ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); ctx.fill();
  }
  function label(ctx, value, x, y, size = 28, color = C.ink, weight = 400, width = Infinity) {
    let font = size;
    do { ctx.font = `${weight} ${font}px Arial, Helvetica, sans-serif`; if (ctx.measureText(value).width <= width) break; font -= 1; } while (font >= 20);
    if (ctx.measureText(value).width > width) throw Error('A report value is too long for this layout. Choose a wider image or a narrower account scope.');
    ctx.fillStyle = color; ctx.textBaseline = 'top'; ctx.fillText(value, x, y);
  }
  function wrap(ctx, value, x, y, width, size, color = C.ink, weight = 400, lines = 3) {
    ctx.font = `${weight} ${size}px Arial, Helvetica, sans-serif`;
    let line = '', row = 0;
    const words = String(value).split(/\s+/);
    for (const word of words) {
      const next = line ? line + ' ' + word : word;
      if (ctx.measureText(next).width > width && line) { label(ctx, line, x, y + row * size * 1.22, size, color, weight, width); row++; line = word; }
      else line = next;
      if (row >= lines) throw Error('Report text does not fit. Choose a larger image layout.');
    }
    if (line) label(ctx, line, x, y + row * size * 1.22, size, color, weight, width);
    return (row + 1) * size * 1.22;
  }
  function chart(ctx, data, x, y, width, height) {
    round(ctx, x, y, width, height, '#FFFFFF');
    label(ctx, data.title, x + 26, y + 24, 28, C.ink, 700, width - 52);
    label(ctx, data.currency || data.unit, x + 26, y + 63, 22, C.muted);
    label(ctx, data.kind === 'comparison' ? 'Equity in yellow' : 'Latest in yellow', x + width - 205, y + 65, 20, C.muted);
    const points = data.points || [], values = points.map(p => p.value).filter(v => v !== null && Number.isFinite(v));
    if (!values.length) { label(ctx, 'N/A · No received data in this period', x + 26, y + height / 2, 25, C.muted, 400, width - 52); return; }
    let low = Math.min(0, ...values), high = Math.max(0, ...values);
    if (low === high) high = low + 1;
    const left = x + 94, top = y + 108, w = width - 126, h = height - 162;
    const py = value => top + (high - value) / (high - low) * h;
    for (let i = 0; i <= 3; i++) {
      const val = low + (high - low) * i / 3, at = py(val);
      ctx.strokeStyle = '#dedcd4'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(left, at); ctx.lineTo(left + w, at); ctx.stroke();
      const raw = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(val);
      label(ctx, raw, x + 18, at - 10, 20, C.muted, 400, 70);
    }
    const slot = w / points.length, every = Math.max(1, Math.ceil(points.length / 5));
    points.forEach((p, i) => {
      const cx = left + slot * (i + .5), last = i === points.length - 1;
      if (p.value !== null && Number.isFinite(p.value)) {
        const sy = py(p.value), zero = py(0);
        round(ctx, cx - slot * .34, Math.min(sy, zero), slot * .68, Math.max(1, Math.abs(zero - sy)), last ? C.yellow : i % 3 === 0 ? C.panel : '#99978f', Math.min(5, slot / 5));
      } else { label(ctx, '–', cx - 8, py(0) - 23, 22, C.muted); }
      if (i % every === 0 || last) {
        ctx.font = '20px Arial'; const name = p.label;
        label(ctx, name, Math.min(x + width - 30 - ctx.measureText(name).width, cx - ctx.measureText(name).width / 2), y + height - 38, 20, C.muted);
      }
    });
  }
  function kpis(ctx, metrics, x, y, width, height, columns = 3) {
    round(ctx, x, y, width, height, C.panel);
    const rows = Math.ceil(metrics.length / columns), cw = (width - 60) / columns, rh = (height - 44) / rows;
    metrics.forEach((m, i) => {
      const cx = x + 30 + (i % columns) * cw, cy = y + 25 + Math.floor(i / columns) * rh;
      const labels = { 'Net closed P/L · period': 'Net closed P/L', 'Received closed deals': 'Closed deals', 'Win rate · received deals': 'Win rate', 'Observed account balance': 'Account balance', 'Observed account equity': 'Account equity', 'Observed floating P/L': 'Floating P/L', 'Linked accounts in scope': 'Linked accounts', 'Accounts with balance data': 'Accounts with data', 'Registered users · now': 'Registered users', 'New registrations · period': 'New registrations', 'Linked MT5 accounts · now': 'MT5 accounts', 'Online MT5 accounts · now': 'Online MT5', 'Active subscribers · now': 'Active subscribers', 'Sandboxes · now': 'Sandboxes', 'Total sandboxes · now': 'Total sandboxes', 'Running with fresh heartbeat': 'Running · fresh', 'Stopped / stopping / suspended': 'Inactive / stopping', 'Running with stale heartbeat': 'Running · stale' };
      const valueFont = rh < 130 ? 42 : 56, labelFont = rh < 130 ? 22 : 28;
      label(ctx, format(m), cx, cy, valueFont, i === 0 ? C.yellow : '#FFFFFF', 700, cw - 22);
      wrap(ctx, labels[m.label] || m.label, cx, cy + valueFont + 10, cw - 22, labelFont, '#D9D8D1', 400, 2);
    });
  }
  function shortLabel(value) {
    return ({'Running with fresh heartbeat':'Running · fresh','Running with stale heartbeat':'Running · stale','Stopped / stopping / suspended':'Inactive / stopping','Accounts with balance data':'Accounts with data','Win rate · received deals':'Win rate','Received closed deals':'Closed deals','Linked accounts in scope':'Linked accounts','Net closed P/L · period':'Net closed P/L'})[value] || value.replace(/^Observed /,'').replace(/ · (now|period)$/,'');
  }
  function fitted(ctx, value, size, width, weight = 700, min = 20) {
    while (size >= min) { ctx.font = `${weight} ${size}px Arial, Helvetica, sans-serif`; if (ctx.measureText(value).width <= width) return size; size--; }
    throw Error('This text is too long for the image. Shorten it or choose a wider layout.');
  }
  function textWidth(ctx, value, size, weight = 400) { ctx.font = `${weight} ${size}px Arial, Helvetica, sans-serif`; return ctx.measureText(value).width; }
  function highlight(ctx, value, x, y, width, size) {
    const font = fitted(ctx, value, size, width - 18);
    const h = font + 12, w = textWidth(ctx, value, font, 700) + 18;
    ctx.fillStyle = C.yellow; ctx.fillRect(x, y, w, h);
    label(ctx, value, x + 9, y + 4, font, C.ink, 700, width - 18);
    return h;
  }
  function editorialHeader(ctx, report, width, margin, story) {
    const logoSize = story ? 92 : 76, logoY = story ? 66 : 54;
    ctx.drawImage(report.logo, margin + 10, logoY, logoSize, logoSize);
    label(ctx, 'CornGrid', margin + logoSize + 40, logoY + 16, story ? 28 : 25, C.ink, 700);
    label(ctx, 'INFRASTRUCTURE', margin + logoSize + 40, logoY + 54, 15, C.muted);
    const right = width - margin, top = logoY + 1;
    const category = report.type === 'blank' ? 'CornGrid announcement' : `${report.period.kind[0].toUpperCase() + report.period.kind.slice(1)} ${report.title}`;
    const font = fitted(ctx, category, 15, story ? 390 : 390, 400, 12), textW = textWidth(ctx, category, font);
    label(ctx, category, right - textW, top, font, C.muted);
    ctx.fillStyle = C.yellow; ctx.beginPath(); ctx.arc(right - textW - 14, top + 8, 4, 0, Math.PI * 2); ctx.fill();
    const day = report.period.end;
    label(ctx, day, right - textWidth(ctx, day, 15), top + 24, 15, C.muted);
    const badge = report.mode === 'manual' ? 'ADMIN-AUTHORED' : report.mode === 'sample' ? 'SAMPLE · SYNTHETIC DATA' : report.period.partial ? 'PERIOD TO DATE' : 'REPORT UPDATE';
    const badgeW = textWidth(ctx, badge, 14, 700) + 20;
    if (report.mode === 'sample') { ctx.fillStyle = C.yellow; ctx.fillRect(right - badgeW, top + 48, badgeW, 28); }
    label(ctx, badge, right - badgeW + 10, top + 54, 14, report.mode === 'sample' ? C.ink : C.muted, 700);
  }
  function editorialChart(ctx, data, report, x, y, width, height) {
    round(ctx, x, y, width, height, '#FFFFFF', 26);
    ctx.strokeStyle = '#e7e5dc'; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(x, y, width, height, 26); ctx.stroke();
    label(ctx, data.title, x + 26, y + 24, 26, C.ink, 700, width - 135);
    const unit = data.currency || data.unit;
    label(ctx, unit, x + width - 26 - textWidth(ctx, unit, 16), y + 30, 16, C.muted);
    const points = data.points || [], values = points.filter(p => p.value !== null && Number.isFinite(p.value)).map(p => p.value);
    const caption = data.kind === 'comparison' ? 'Balance and equity observations · same currency' : `Dates in ${report.timezone} · yellow marks the latest period`;
    label(ctx, caption, x + 26, y + height - 31, 15, C.muted, 400, width - 52);
    if (!values.length) { label(ctx, 'N/A · No received data in this period', x + 26, y + height / 2 - 12, 24, C.muted, 400, width - 52); return; }
    const actualLow = Math.min(0, ...values), actualHigh = Math.max(0, ...values);
    const rawStep = (actualHigh - actualLow || 1) / 3, exponent = 10 ** Math.floor(Math.log10(rawStep));
    const fraction = rawStep / exponent;
    let step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * exponent;
    if (data.unit === 'count') step = Math.max(1, step);
    const low = Math.floor(actualLow / step) * step;
    let high = Math.ceil(actualHigh / step) * step;
    if (high === low) high = low + step;
    const left = x + 108, top = y + 90, plotW = width - 144, plotH = height - 174;
    if (plotH < 70) throw Error('The chart is too short for readable labels. Choose a taller image.');
    const py = value => top + (high - value) / (high - low) * plotH;
    for (let i = 0; i <= Math.round((high - low) / step); i++) {
      const value = low + step * i, at = py(value);
      ctx.strokeStyle = '#e6e4de'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(left, at); ctx.lineTo(left + plotW, at); ctx.stroke();
      const tick = new Intl.NumberFormat('en-US', {notation:'compact', maximumFractionDigits:2}).format(value);
      label(ctx, tick, left - 14 - textWidth(ctx, tick, 18), at - 10, 18, C.muted);
    }
    const slot = plotW / points.length, every = Math.max(1, Math.ceil(points.length / 6));
    points.forEach((point, i) => {
      const cx = left + slot * (i + .5), last = i === points.length - 1;
      if (point.value !== null && Number.isFinite(point.value)) {
        const barY = py(point.value), zero = py(0), barH = Math.abs(zero - barY), barW = slot * .76;
        if (barH > 0) {
          round(ctx, cx - barW / 2, Math.min(barY, zero), barW, barH, last ? C.yellow : i % 3 === 0 ? C.panel : '#99978f', Math.min(6, barW / 5, barH / 2));
          if (last) { ctx.strokeStyle = '#b3a700'; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(cx - barW / 2, Math.min(barY, zero), barW, barH, Math.min(6, barW / 5, barH / 2)); ctx.stroke(); }
        }
        if (last || points.length <= 8) {
          const value = format({value:point.value,unit:'number'});
          const font = fitted(ctx, value, 22, Math.max(slot - 6, 36), 700, 14);
          const insideNegative = point.value < 0 && barH >= font + 12;
          const valueY = point.value < 0 ? insideNegative ? Math.min(barY - font - 5, zero + (barH - font) / 2) : Math.max(y + 66, zero - font - 8) : Math.max(y + 66, barY - font - 8);
          label(ctx, value, cx - textWidth(ctx, value, font, 700) / 2, valueY, font, insideNegative && !last && i % 3 === 0 ? '#FFFFFF' : C.ink, 700);
        }
      } else label(ctx, 'N/A', cx - 16, top + plotH / 2, 16, C.muted);
      if (i === 0 || last || i % every === 0 && points.length - 1 - i > every * .6) {
        const font = fitted(ctx, point.label, 18, Math.max(70, slot * every - 10), last ? 700 : 400, 14);
        const tw = textWidth(ctx, point.label, font, last ? 700 : 400);
        label(ctx, point.label, Math.max(left - 12, Math.min(x + width - 25 - tw, cx - tw / 2)), y + height - 76, font, C.muted, last ? 700 : 400);
      }
      if (last && data.kind !== 'comparison') label(ctx, 'latest', cx - textWidth(ctx, 'latest', 15, 700) / 2, y + height - 54, 15, C.ink, 700);
    });
  }
  function editorialKpis(ctx, metrics, x, y, width, height, columns) {
    round(ctx, x, y, width, height, C.panel, 26);
    const rows = Math.ceil(metrics.length / columns), gap = 26, colW = (width - 64 - gap * (columns - 1)) / columns, rowH = (height - 54) / rows;
    metrics.forEach((metric, i) => {
      const cx = x + 32 + i % columns * (colW + gap), cy = y + 28 + Math.floor(i / columns) * rowH;
      const maxFont = rowH >= 150 ? 66 : rowH >= 120 ? 54 : 44;
      const value = format(metric), font = fitted(ctx, value, maxFont, colW, 700, 24);
      label(ctx, value, cx, cy, font, i === 0 ? C.yellow : '#FFFFFF', 700, colW);
      const captionFont = rowH >= 150 ? 28 : 23;
      const captionH = wrap(ctx, shortLabel(metric.label), cx, cy + maxFont + 10, colW, captionFont, '#D9D8D1', 400, 3);
      if (maxFont + 10 + captionH > rowH - 8) throw Error('KPI labels exceed this layout. Choose Story or shorten the captions.');
    });
  }
  function customContent(ctx, report, x, y, w, h) {
    const content = report.content || {}, limits = {title:100,subtitle:180,highlight:80,body:2000,byline:64};
    for (const [name, limit] of Object.entries(limits)) if (typeof (content[name] ?? '') !== 'string' || (content[name] || '').length > limit) throw Error(`Custom ${name} must contain at most ${limit} characters.`);
    const hasContent = Object.values(content).some(value => typeof value === 'string' && value.trim());
    if (!hasContent) return; // A truly blank body: no sample text or invented metrics.
    const inner = w, limit = y + h - (content.byline?.trim() ? 70 : 12);
    let cursor = y;
    const write = (value, size, color = C.ink, weight = 400) => {
      if (!value?.trim()) return;
      for (const paragraph of value.replace(/\r\n/g,'\n').split('\n')) {
        if (!paragraph.trim()) { cursor += size * .8; continue; }
        cursor += wrap(ctx, paragraph, x, cursor, inner, size, color, weight, 60) + size * .4;
        if (cursor > limit) throw Error('Custom content exceeds this image. Shorten the text or choose Story; text is never cropped.');
      }
    };
    write(content.title, 60, C.ink, 800); write(content.subtitle, 27, C.muted);
    if (content.highlight?.trim()) {
      cursor += highlight(ctx, content.highlight.trim(), x, cursor, inner, 30) + 24;
      if (cursor > limit) throw Error('Custom content exceeds this image. Shorten the text or choose Story.');
    }
    write(content.body, 32);
    if (content.byline?.trim()) label(ctx, content.byline.trim(), x, y + h - 42, 24, C.muted, 700, inner);
  }
  function editorialTemplate(ctx, report, x, y, w, h, wide, story) {
    if (report.type === 'blank') { customContent(ctx, report, x, y, w, h); return; }
    const headlines = {growth:'A clearer view of\nplatform growth.',sandbox:'Your infrastructure,\nat a glance.',funds:'Account funds,\nin clear view.',performance:'Trading performance,\nby the numbers.',account:'Your account,\nby the numbers.',partner:'Your partner progress,\nin clear view.',subscription:'A clearer picture of\nsubscriptions.',milestone:'A CornGrid update,\nworth sharing.'};
    const contexts = {
      growth:'Registrations in the selected period, alongside current platform totals.',
      sandbox:'A current status snapshot. Running counts require a fresh heartbeat.',
      funds:!report.currency ? 'Choose one currency to view monetary totals.' : report.period.partial ? 'Latest received account observations, kept in one currency.' : 'Last received account observations inside the selected reporting period.',
      performance:'Net P/L includes commission and swap from received closed deals.',
      account:!report.currency ? 'Choose one account currency to view monetary totals.' : 'Net P/L includes commission and swap from your received closed deals.',
      partner:!report.currency ? 'Choose one partner currency to view monetary totals.' : 'Your recorded commissions and payouts, alongside current strategy totals.',
      subscription:'Current subscriber status with recorded activations in the selected period.',
      milestone:'An observed platform highlight, with supporting statistics.'
    };
    const headline = wide ? headlines[report.type].replace('\n',' ') : headlines[report.type];
    const font = story ? 72 : wide ? 60 : 60;
    let cursor = y;
    for (const line of headline.split('\n')) { label(ctx, line, x, cursor, font, C.ink, 800, w); cursor += font * 1.03; }
    cursor += 12;
    const primaryIndex = report.type === 'milestone' ? report.milestone?.metricIndex ?? 0 : 0;
    const secondaryIndex = report.type === 'sandbox' ? 1 : ['account', 'performance'].includes(report.type) ? 2 : report.type === 'subscription' ? 3 : report.type === 'milestone' && primaryIndex === 1 ? 0 : 1;
    const primary = report.metrics[primaryIndex], secondary = report.metrics[secondaryIndex];
    const number = format(primary), caption = shortLabel(primary.label), captionFont = story ? 34 : 29;
    const captionW = textWidth(ctx, caption, captionFont, 700), rowH = story ? 130 : 100;
    const numberFont = fitted(ctx, number, story ? 120 : 94, w - Math.min(captionW, w * .46) - 22, 800, 30);
    const numberW = textWidth(ctx, number, numberFont, 800);
    label(ctx, number, x, cursor + rowH - numberFont - 4, numberFont, C.ink, 800);
    label(ctx, caption, x + numberW + 18, cursor + rowH - captionFont - 8, captionFont, C.ink, 700, w - numberW - 18);
    cursor += rowH + 9;
    cursor += highlight(ctx, `${format(secondary)} ${shortLabel(secondary.label)}`, x, cursor, w, story ? 34 : 29) + 14;
    const context = report.mode === 'sample' ? 'Synthetic demonstration only. Replace these values with a verified CornGrid export.' : contexts[report.type];
    cursor += wrap(ctx, context, x, cursor, w, story ? 27 : 21, C.muted, 400, 2) + (story ? 30 : 24);
    const remaining = y + h - cursor, gap = story ? 32 : 26;
    const panelMetrics = report.type === 'milestone' ? [0,1,4,5,2].filter(i => i !== primaryIndex).slice(0,3).map(i => report.metrics[i]) : report.metrics;
    if (wide) {
      editorialChart(ctx, report.chart, report, x, cursor, w * .56 - 14, remaining);
      editorialKpis(ctx, panelMetrics, x + w * .56 + 14, cursor, w * .44 - 14, remaining, report.type === 'milestone' ? 1 : 2);
    } else {
      const minimumPanel = report.type === 'milestone' ? 200 : story ? 490 : 298;
      const plotH = Math.min(story ? 480 : 340, remaining - gap - minimumPanel);
      if (plotH < 244) throw Error('The editorial layout is too full. Choose Story or Landscape.');
      editorialChart(ctx, report.chart, report, x, cursor, w, plotH);
      editorialKpis(ctx, panelMetrics, x, cursor + plotH + gap, w, remaining - plotH - gap, report.type === 'milestone' ? 3 : story ? 2 : 3);
    }
  }
  function editorialFooter(ctx, report, width, height, m, body, story) {
    const y = height - (story ? 198 : 174);
    ctx.strokeStyle = '#d5d1c5'; ctx.beginPath(); ctx.moveTo(m, y); ctx.lineTo(width - m, y); ctx.stroke();
    label(ctx, 'CornGrid Infrastructure', m, y + 57, 24, C.ink, 700);
    label(ctx, 'corngrid.com', m, y + 88, 20, C.ink, 700);
    const foot = ({growth:'Current totals + period registrations · archived profiles excluded.',sandbox:'Current status snapshot · running requires a fresh heartbeat.',funds:'Observed account funds · one currency · not deposits or platform revenue.',performance:'Received MT5 deals · net P/L includes commission and swap · N/A = unavailable.',account:'Your received MT5 deals · net P/L includes costs · N/A = unavailable.',partner:'Current ledger status · commissions by creation date · payouts by paid date.',subscription:'Current subscription status + recorded period activations · no revenue inferred.',milestone:'Verified platform snapshot · current totals and period registrations.',blank:'Admin-authored content · CornGrid announcement'})[report.type];
    label(ctx, foot, m, y + 20, 18, C.muted, 400, body);
    const localStamp = new Intl.DateTimeFormat('en-GB', {timeZone:report.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(report.generatedAt));
    const period = `${report.period.start} – ${report.period.end}`;
    const prepared = `${report.timezone} · ${report.type === 'blank' ? 'Prepared' : 'Generated'} ${localStamp}`;
    label(ctx, period, width - m - textWidth(ctx, period, 14), y + 65, 14, C.muted);
    label(ctx, prepared, width - m - textWidth(ctx, prepared, 14), y + 91, 14, C.muted);
    const source = report.type === 'blank' ? 'Content entered by an administrator · not an automated statistics report' : report.mode === 'sample' ? 'Synthetic preview · not production data' : report.sourceAsOf ? `Oldest included observation: ${new Date(report.sourceAsOf).toISOString().replace('T',' ').slice(0,19)} UTC` : 'Source: CornGrid platform records';
    label(ctx, source, m, y + 127, 14, C.muted, 400, body);
  }
  async function render(report, dimensions, logo) {
    await document.fonts.ready;
    if (!logo.complete || !logo.naturalWidth) throw Error('The official CornGrid logo is unavailable. Try again after restoring the original asset.');
    const [width, height] = dimensions.split('x').map(Number);
    if (![[1080, 1350], [1080, 1920], [1920, 1080]].some(([w, h]) => w === width && h === height)) throw Error('Unsupported report dimensions.');
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = C.paper; ctx.fillRect(0, 0, width, height);
    const wide = width > height, story = height === 1920, m = 56, body = width - 2 * m;
    if (report.scope === 'admin' || report.scope === 'user') {
      const margin = story ? 60 : wide ? 64 : 52, contentW = width - margin * 2;
      editorialHeader(ctx, { ...report, logo }, width, margin, story);
      const top = story ? 230 : 170, footerY = height - (story ? 198 : 174);
      editorialTemplate(ctx, report, margin, top, contentW, footerY - top - 26, wide, story);
      editorialFooter(ctx, report, width, height, margin, contentW, story);
      return canvas;
    }
    ctx.drawImage(logo, m, 44, 96, 96);
    label(ctx, 'CornGrid', m + 120, 62, 30, C.ink, 700); label(ctx, 'INFRASTRUCTURE', m + 120, 104, 20, C.muted);
    const badge = report.mode === 'manual' ? 'ADMIN UPDATE' : report.mode === 'sample' ? 'SAMPLE DATA' : report.period.partial ? 'PERIOD TO DATE' : 'REPORT UPDATE';
    round(ctx, width - m - 280, 58, 280, 44, C.yellow, 22); label(ctx, badge, width - m - 262, 68, 22, C.ink, 700);
    label(ctx, report.period.start + ' – ' + report.period.end, width - m - 300, 115, 22, C.muted, 400, 300);
    const title = `${report.period.kind[0].toUpperCase() + report.period.kind.slice(1)} ${report.title.toLowerCase()}`;
    const titleHeight = wrap(ctx, title, m, 180, body, wide ? 62 : 56, C.ink, 800, 2);
    const heroY = 180 + titleHeight + 12;
    label(ctx, format(report.metrics[0]), m, heroY, 88, C.ink, 800, body);
    label(ctx, report.metrics[0].label, m, heroY + 98, 30, C.muted, 400, body);
    const areaY = heroY + 154;
    if (wide) {
      chart(ctx, report.chart, m, areaY, body * .55 - 12, 390);
      kpis(ctx, report.metrics, m + body * .55 + 12, areaY, body * .45 - 12, 390, 2);
    } else {
      chart(ctx, report.chart, m, areaY, body, story ? 420 : 300);
      kpis(ctx, report.metrics, m, areaY + (story ? 450 : 326), body, story ? 540 : 310, story ? 2 : 3);
    }
    const footerY = height - 218;
    const contentEnd = wide ? areaY + 390 : areaY + (story ? 990 : 636);
    if (contentEnd > footerY - 20) throw Error('The report is too tall for this layout. Choose Story or Landscape.');
    ctx.strokeStyle = '#d5d1c5'; ctx.beginPath(); ctx.moveTo(m, footerY); ctx.lineTo(width - m, footerY); ctx.stroke();
    label(ctx, 'CornGrid Infrastructure', m, footerY + 22, 26, C.ink, 700);
    label(ctx, 'corngrid.com', width - m - 190, footerY + 25, 26, C.ink, 700, 190);
    const foot = report.type === 'growth' ? 'Current totals + period registrations · archived profiles excluded.' : report.type === 'sandbox' ? 'Current sandbox status · fresh heartbeat required for running status.' : 'Received MT5 records · net P/L includes commission and swap · N/A = unavailable.';
    wrap(ctx, foot, m, footerY + 70, body, 22, C.muted, 400, 2);
    const localStamp = new Intl.DateTimeFormat('en-GB', { timeZone: report.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(report.generatedAt));
    label(ctx, `Generated ${localStamp} · ${report.timezone}`, m, footerY + 132, 20, C.muted, 400, body);
    const asof = report.mode === 'sample' ? 'Synthetic preview · not production data' : report.sourceAsOf ? 'Oldest included observation: ' + new Date(report.sourceAsOf).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'Source: CornGrid platform records · no synthetic values';
    label(ctx, asof, m, footerY + 164, 20, C.muted, 400, body);
    if (report.notes.some(n => /stale/.test(n))) label(ctx, 'Includes stale / missing account observations', m, areaY - 22, 20, C.muted, 700, body);
    return canvas;
  }
  window.CornGridReportRenderer = { render, format };
})();
