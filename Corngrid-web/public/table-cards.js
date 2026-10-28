(function () {
  'use strict';

  if (window.__cornGridTableCards) return;
  window.__cornGridTableCards = true;

  var MOBILE_QUERY = '(max-width: 639px)';
  var mobile = window.matchMedia(MOBILE_QUERY);
  var frame = 0;

  function createToggle() {
    var cell = document.createElement('td');
    cell.className = 'cell-toggle';
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'card-toggle';
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = '<span class="card-toggle-text">More details</span><svg class="card-toggle-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    cell.appendChild(button);
    return cell;
  }

  function syncRow(row) {
    var toggle = row.querySelector(':scope > td.cell-toggle');
    var hasExtras = row.querySelector(':scope > td.cell-extra');
    if (!mobile.matches || !hasExtras || row.querySelector(':scope > td.table-empty')) {
      if (toggle) toggle.remove();
      row.classList.remove('is-expanded');
      return;
    }
    if (toggle) return;
    row.appendChild(createToggle());
  }

  function sync() {
    frame = 0;
    var rows = document.querySelectorAll('.table-scroll > table > tbody > tr');
    for (var i = 0; i < rows.length; i += 1) syncRow(rows[i]);
  }

  function schedule() {
    if (frame) return;
    frame = window.requestAnimationFrame(sync);
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest('.card-toggle');
    if (!button) return;
    var row = button.closest('tr');
    if (!row) return;
    var expanded = row.classList.toggle('is-expanded');
    button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    var label = button.querySelector('.card-toggle-text');
    if (label) label.textContent = expanded ? 'Hide details' : 'More details';
  });

  if (mobile.addEventListener) mobile.addEventListener('change', schedule);
  else if (mobile.addListener) mobile.addListener(schedule);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule);
  } else {
    schedule();
  }

  new MutationObserver(function (mutations) {
    for (var m = 0; m < mutations.length; m += 1) {
      var added = mutations[m].addedNodes;
      for (var n = 0; n < added.length; n += 1) {
        var node = added[n];
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'TR' || (node.querySelector && node.querySelector('tr'))) {
          schedule();
          return;
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
