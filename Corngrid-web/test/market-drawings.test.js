const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const MARKET_JS = path.join(__dirname, '..', 'public', 'market.js');
const source = fs.readFileSync(MARKET_JS, 'utf8');

// The chart-drawing lifecycle rules that were broken:
//  1. price lines must be cleared before the series is re-filled, otherwise every
//     timeframe change stacks another line and the old ones become undeletable;
//  2. a drawing must never be applied twice;
//  3. a deleted drawing must leave the state before the chart is re-rendered,
//     otherwise the trend line is painted again right after being deleted;
//  4. a saved trend point must be re-anchored onto the current timeframe's bars.

test('market drawings: price lines are cleared before the series is re-filled', () => {
  const clearFn = source.slice(source.indexOf('function clearChartPriceLines'), source.indexOf('function describeDrawing'));
  assert.ok(clearFn.includes('removePriceLine'), 'clearChartPriceLines must remove the existing price lines');
  assert.ok(clearFn.includes('state.priceLines.clear()'), 'clearChartPriceLines must empty the tracking map');

  // loadCandles() must clear before it re-applies the drawings.
  const loadCandles = source.slice(source.indexOf('async function loadCandles'), source.indexOf('async function loadDrawings'));
  const clearAt = loadCandles.indexOf('clearChartPriceLines()');
  const applyAt = loadCandles.indexOf('state.drawings.forEach(addDrawingToChart)');
  assert.ok(clearAt > -1, 'loadCandles must clear the chart price lines');
  assert.ok(applyAt > -1, 'loadCandles must re-apply the drawings');
  assert.ok(clearAt < applyAt, 'the price lines must be cleared before the drawings are applied again');
});

test('market drawings: the same drawing is never applied twice', () => {
  const addFn = source.slice(source.indexOf('function addDrawingToChart'), source.indexOf('function removeDrawingFromChart'));
  assert.ok(
    addFn.includes('state.priceLines.has(drawing.id)'),
    'addDrawingToChart must skip a drawing that is already on the chart'
  );
});

test('market drawings: a deleted drawing leaves the state before the chart re-renders', () => {
  const removeFn = source.slice(source.indexOf('async function removeDrawing'), source.indexOf('function setTool'));
  const filterAt = removeFn.indexOf('state.drawings = state.drawings.filter');
  const chartAt = removeFn.indexOf('removeDrawingFromChart(drawing)');
  assert.ok(filterAt > -1, 'removeDrawing must drop the drawing from the state');
  assert.ok(chartAt > -1, 'removeDrawing must detach the drawing from the chart');
  assert.ok(filterAt < chartAt, 'the drawing must leave the state before the chart is re-rendered');
});

test('market drawings: saved trend points are re-anchored onto the current bars', () => {
  assert.ok(source.includes('function anchorTrendPoints'), 'a trend point anchor helper is required');
  assert.ok(source.includes('function snapToBarTime'), 'the anchor helper must snap to the nearest bar');
  const renderFn = source.slice(source.indexOf('function renderTrendLines'), source.indexOf('function priceLineOptions'));
  assert.ok(
    renderFn.includes('anchorTrendPoints(drawing)'),
    'renderTrendLines must use the anchored points so a line survives a timeframe change'
  );
});

test('market drawings: the chart is fully reset when the page is torn down', () => {
  const destroyFn = source.slice(source.indexOf('function destroy()'), source.indexOf('window.CornGridMarket'));
  assert.ok(
    destroyFn.includes('removeChild(state.trendOverlay)'),
    'destroy must remove the trend overlay so it is not stacked on the next chart'
  );
  assert.ok(destroyFn.includes('state.priceLines.clear()'), 'destroy must clear the price line map');
});

test('market drawings: the drawing id is a number everywhere', () => {
  assert.ok(
    source.includes('id: Number(created.id)'),
    'a newly saved drawing must use the numeric id returned by the server'
  );
  assert.ok(
    source.includes('id: Number(drawing.id)'),
    'loaded drawings must be normalised to the numeric id as well'
  );
});
