// CornGrid EA Smooth Counter Animation
// Lightweight requestAnimationFrame-based counter for real-time number transitions.
// Honors prefers-reduced-motion media query.
// Sets Counter, createCounter, and animateNumber as globals for regular script loading.

(function () {
  'use strict';

  // Counter class for smooth number animations
  window.CornGridCounter = window.CornGridCounter || {};

  window.Counter = window.CornGridCounter.Counter = class Counter {
    constructor({ element, start, end, format = '#,##0.00', prefix = '', suffix = '', onUpdate, onComplete, duration = 600 } = {}) {
      if (!element || typeof start !== 'number' || typeof end !== 'number') {
        console.error('Counter: element, start, and end are required');
        return;
      }

      this.element = element;
      this.start = start;
      this.end = end;
      this.format = format;
      this.prefix = prefix;
      this.suffix = suffix;
      this.onUpdate = onUpdate;
      this.onComplete = onComplete;
      this.duration = Math.max(100, Math.min(2000, duration));
      this.running = false;
      this.startTime = 0;

      // Check for reduced motion preference
      this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      // Initialize element with start value
      this._render(this.start);
    }

    start() {
      if (this.running || this.reduceMotion) {
        this._render(this.end);
        if (this.onComplete) this.onComplete();
        return;
      }

      this.running = true;
      this.startTime = performance.now();
      this._animate();
    }

    _animate() {
      const now = performance.now();
      const elapsed = now - this.startTime;
      const progress = Math.min(elapsed / this.duration, 1);
      const eased = this.easing(progress);
      const current = this.start + (this.end - this.start) * eased;

      this._render(current);

      if (progress < 1) {
        requestAnimationFrame(() => this._animate());
      } else {
        this.running = false;
        if (this.onComplete) this.onComplete();
      }
    }

    _render(value) {
      const formatted = this._formatNumber(value);
      const display = `${this.prefix}${formatted}${this.suffix}`;

      if (this.element.tagName === 'INPUT' || this.element.tagName === 'TEXTAREA') {
        this.element.value = display;
      } else {
        this.element.textContent = display;
      }

      if (this.onUpdate) this.onUpdate(display, value);
    }

    _formatNumber(value) {
      if (!Number.isFinite(value)) return '0';

      const match = this.format.match(/\.(\d+)/);
      const decimalPlaces = match ? parseInt(match[1], 10) : 2;

      let formatted;
      if (this.format.includes('%')) {
        formatted = Number(value).toFixed(decimalPlaces);
        const parts = formatted.split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        formatted = parts.join('.');
      } else if (this.format.includes(',')) {
        const fixed = value.toFixed(decimalPlaces);
        formatted = fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      } else {
        formatted = Number(value).toFixed(decimalPlaces);
      }

      if (!this.format.includes('.') && formatted.includes('.')) {
        formatted = formatted.replace(/\.0+$/, '');
      }

      return formatted;
    }

    stop() {
      this.running = false;
      this._render(this.end);
      if (this.onComplete) this.onComplete();
    }
  };

  // Shorthand factory function
  window.CornGridCounter.createCounter = function ({ element, start, end, format, prefix, suffix, onUpdate, onComplete, duration }) {
    return new this.Counter({ element, start, end, format, prefix, suffix, onUpdate, onComplete, duration });
  };

  // Quick helper: animate a number in a DOM element from start to end
  window.CornGridCounter.animateNumber = function (element, start, end, options = {}) {
    const format = options.format || element.dataset.format;
    const elementText = element.textContent || '0';
    const prefixMatch = elementText.match(/^[\$£₹€¥]/);
    const suffixMatch = elementText.match(/[%]$/) || elementText.match(/[A-Z]{3}$/);
    const prefix = prefixMatch ? prefixMatch[0] : (options.prefix || '');
    const suffix = suffixMatch ? (suffixMatch[0] === '%' ? '%' : (suffixMatch[0] || '')) : (options.suffix || '');
    const duration = options.duration !== undefined ? options.duration : 600;

    // Strip any existing prefix/suffix to get the numeric value
    const numericMatch = elementText.match(/[\-+]?\d*\.?\d+/);
    const currentValue = numericMatch ? parseFloat(numericMatch[0]) : start;

    const counter = new this.Counter({
      element,
      start: currentValue,
      end,
      format,
      prefix: prefix === '' ? undefined : prefix,
      suffix: suffix === '' ? undefined : suffix,
      duration
    });

    counter.start();
    return counter;
  };
})();