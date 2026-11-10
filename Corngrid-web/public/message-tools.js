/* Shared plain-text composer tools. User HTML is never rendered. */
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
  const dialog = document.createElement('dialog');
  dialog.className = 'message-tools-dialog';
  dialog.setAttribute('aria-labelledby', 'message-tools-title');
  dialog.innerHTML = `<form method="dialog"><div class="message-tools-heading"><h2 id="message-tools-title">Add emoji</h2><button class="button button-secondary" value="cancel" aria-label="Close">✕</button></div><div class="message-emoji-grid"></div><div class="message-link-fields" hidden><label for="message-link-url">Website link</label><input id="message-link-url" class="input-control" type="url" placeholder="https://example.com" autocomplete="off"><p class="muted small" id="message-link-error" role="status"></p><button type="button" class="button button-primary" id="message-link-insert">Insert link</button></div></form>`;
  document.body.append(dialog);
  dialog.querySelector('form').append(dialog.querySelector('#message-link-error'));
  dialog.querySelector('form').addEventListener('submit', event => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault();
    if (!dialog.querySelector('.message-link-fields').hidden) dialog.querySelector('#message-link-insert').click();
  });
  const emojis = ['😀','😊','😂','😍','😎','🤔','😅','🥳','👍','👎','👏','🙏','💪','🤝','❤️','🔥','🎉','✅','🚀','💯','📈','📉','💰','🎯','⚠️','👀','🙌','✨','😢','🤩','🟢','🔴'];
  const grid = dialog.querySelector('.message-emoji-grid');
  for (const emoji of emojis) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = emoji;
    button.setAttribute('aria-label', 'Insert ' + emoji);
    button.addEventListener('click', () => insert(emoji)); grid.append(button);
  }
  let active, start = 0, end = 0, opener;
  function insert(text) {
    if (!active?.isConnected || active.disabled || active.readOnly) { dialog.close(); return; }
    const limit = active.maxLength;
    if (limit >= 0 && active.value.length - (end - start) + text.length > limit) {
      dialog.querySelector('#message-link-error').textContent = 'Character limit reached. Shorten your message first.';
      dialog.querySelector('#message-link-error').hidden = false;
      return;
    }
    active.setRangeText(text, start, end, 'end');
    active.dispatchEvent(new Event('input', { bubbles: true }));
    dialog.close(); active.focus();
  }
  dialog.querySelector('#message-link-insert').addEventListener('click', () => {
    const field = dialog.querySelector('#message-link-url');
    try {
      const value = field.value.trim();
      const url = new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.') || url.username || url.password) throw new Error('url');
      insert(url.href);
    } catch { dialog.querySelector('#message-link-error').textContent = 'Enter a valid http or https website link.'; field.focus(); }
  });
  dialog.addEventListener('close', () => { if (active?.isConnected) active.focus(); else opener?.focus(); });
  function attach() {
    document.querySelectorAll('#feed-composer-input, [data-comment-form] input[type="text"], #chat-composer-text').forEach(input => {
      if (input.dataset.messageTools) return;
      input.dataset.messageTools = 'true';
      const bar = document.createElement('div'); bar.className = 'message-composer-tools';
      bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'Message tools');
      for (const [mode, label] of [['emoji','Add emoji'], ['link','Insert link']]) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'button button-secondary button-small';
        button.setAttribute('aria-label', label); button.title = label;
        button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${mode === 'emoji' ? '<circle cx="12" cy="12" r="9"/><path d="M8 14s1 3 4 3 4-3 4-3"/><path d="M8 9h.01M16 9h.01"/>' : '<path d="M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l2-2"/>'}</svg>`;
        button.setAttribute('aria-haspopup', 'dialog');
        button.addEventListener('click', () => {
          active = input; opener = button; start = input.selectionStart; end = input.selectionEnd;
          const isLink = mode === 'link';
          dialog.querySelector('h2').textContent = isLink ? 'Add link' : 'Add emoji';
          grid.hidden = isLink;
          dialog.querySelector('.message-link-fields').hidden = !isLink;
          dialog.querySelector('#message-link-error').textContent = '';
          dialog.querySelector('#message-link-url').value = isLink ? input.value.slice(start, end) : '';
          dialog.showModal();
          if (isLink) dialog.querySelector('#message-link-url').focus();
        }); bar.append(button);
      }
      if (input.id === 'feed-composer-input') document.querySelector('.feed-composer-tools').prepend(bar);
      else { input.parentElement.classList.add('has-message-tools'); input.before(bar); }
    });
  }
  attach();
  new MutationObserver(attach).observe(document.body, { childList: true, subtree: true });
})();
