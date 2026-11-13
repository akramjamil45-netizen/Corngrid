/* Render keyboard-entered text and links. User HTML is never rendered. */
(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function render(value) {
    const text = String(value ?? '');
    let output = '', end = 0;
    for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"']+/gi)) {
      const url = match[0].replace(/[.,!?;:)\]}]+$/, '');
      output += escape(text.slice(end, match.index));
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocol');
        output += `<a class="message-link" href="${escape(parsed.href)}" target="_blank" rel="noopener noreferrer ugc">${escape(url)}</a>`;
      } catch { output += escape(url); }
      end = match.index + url.length;
    }
    return (output + escape(text.slice(end))).replace(/\n/g, '<br>');
  }
  window.CornGridMessageTools = { render };
})();
