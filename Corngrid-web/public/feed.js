(() => {
  // CornGrid Live Feed: community posts, comments, likes, and profile views.
  // Talks to /api/feed endpoints; all user content is escaped before rendering (XSS).
  const API = '/api';
  const MAX_POST_LENGTH = 4000;
  const MAX_COMMENT_LENGTH = 2000;

  const state = {
    filter: 'latest',
    posts: [],
    cursor: null,
    loading: false,
    loaded: false,
    editingPostId: null,
    composerImage: null,
    profile: null,
    profilePosts: [],
    profileActivity: [],
    profileTab: 'posts',
    openComments: new Map(), // postId -> { comments, loading }
    abortController: null
  };

  const $ = id => document.getElementById(id);
  const seenPostIds = new Set();
  const seenCommentIds = new Set();

  function animateNewChildren(host, selector, seen, key) {
    if (!host) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let index = 0;
    host.querySelectorAll(selector).forEach(node => {
      const id = node.dataset[key];
      if (!id || seen.has(id)) return;
      seen.add(id);
      if (reduceMotion) return;
      node.style.setProperty('--motion-index', String(Math.min(index++, 6)));
      node.classList.add('is-entering');
      node.addEventListener('animationend', event => {
        if (event.target !== node) return;
        node.classList.remove('is-entering');
        node.style.removeProperty('--motion-index');
      });
    });
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }

  function toast(message, type = '') {
    const region = document.getElementById('toast-region');
    if (!region) return;
    const item = document.createElement('div');
    item.className = `toast ${type ? `toast-${type}` : ''}`;
    item.textContent = message;
    region.append(item);
    window.setTimeout(() => item.remove(), 4500);
  }

  async function request(path, options = {}) {
    let signal = options.signal;
    if (!signal) {
      const controllerSignal = state.abortController && state.abortController.signal;
      const timeoutSignal = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
        ? AbortSignal.timeout(30000)
        : null;
      if (controllerSignal && timeoutSignal && typeof AbortSignal.any === 'function') {
        signal = AbortSignal.any([controllerSignal, timeoutSignal]);
      } else if (controllerSignal) {
        signal = controllerSignal;
      } else if (timeoutSignal) {
        signal = timeoutSignal;
      }
    }
    const response = await fetch(`${API}${path}`, {
      ...options,
      credentials: 'same-origin',
      signal,
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

  // Relative timestamps with an exact date available on hover (title attribute).
  function timeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 45) return 'just now';
    const units = [
      [60, 'minute'], [60, 'hour'], [24, 'day'], [7, 'week'], [4.35, 'month'], [12, 'year']
    ];
    let value = seconds;
    let label = 'second';
    for (const [step, name] of units) {
      if (value < step) break;
      value = Math.floor(value / step);
      label = name;
    }
    const plural = value === 1 ? '' : 's';
    return `${value} ${label}${plural} ago`;
  }

  function exactTime(timestamp) {
    return new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function initials(name) {
    const text = String(name || '?').trim();
    return (text[0] || '?').toUpperCase();
  }

  // ---- Post card rendering (all user content passes through escapeHtml) ----
  function renderPostCard(post, { canManage = false, isAnnouncement = false } = {}) {
    const authorName = isAnnouncement ? 'CornGrid Announcement' : (post.author.displayName || post.author.username || 'Unknown');
    const authorUsername = post.author.username ? `@${escapeHtml(post.author.username)}` : 'Official';
    const badge = isAnnouncement
      ? '<span class="feed-badge feed-badge-official">Official Announcement</span>'
      : (post.isPinned ? '<span class="feed-badge feed-badge-pinned">Pinned</span>' : '');
    const edited = post.edited ? '<span class="feed-edited" title="' + escapeHtml(exactTime(post.updatedAt)) + '">· edited</span>' : '';
    const image = post.imagePath
      ? `<img class="feed-image" src="${escapeHtml(post.imagePath)}" alt="Post image" loading="lazy">`
      : '';
    const menu = canManage
      ? `<div class="feed-card-menu">
           <button type="button" class="button button-secondary button-small" data-feed-edit="${escapeHtml(post.id)}">Edit</button>
           <button type="button" class="button button-secondary button-small" data-feed-delete="${escapeHtml(post.id)}">Delete</button>
         </div>`
      : `<div class="feed-card-menu">
           <button type="button" class="button button-secondary button-small" data-feed-report="${escapeHtml(post.id)}" data-report-type="post">Report</button>
         </div>`;
    return `
      <article class="feed-card${isAnnouncement ? ' feed-card-announcement' : ''}" data-post-id="${escapeHtml(post.id)}">
        <div class="feed-card-head">
          <button type="button" class="feed-avatar-btn" data-feed-profile="${escapeHtml(post.author.username || '')}" ${post.author.username ? '' : 'disabled'}>
            ${CornGridAvatar.html(post.author, '', 'feed-avatar')}
          </button>
          <div class="feed-card-author">
            <strong>${escapeHtml(authorName)}</strong>
            <span class="muted small">${authorUsername} · <time datetime="${new Date(post.createdAt).toISOString()}" title="${escapeHtml(exactTime(post.createdAt))}">${escapeHtml(timeAgo(post.createdAt))}</time>${edited}</span>
          </div>
          ${badge}
        </div>
        ${post.title ? `<h3 class="feed-card-title">${escapeHtml(post.title)}</h3>` : ''}
        <div class="feed-card-content">${escapeHtml(post.content).replace(/\n/g, '<br>')}</div>
        ${image}
        <div class="feed-card-actions">
          <button type="button" class="feed-action${post.likedByMe ? ' is-active' : ''}" data-feed-like="${escapeHtml(post.id)}" aria-pressed="${post.likedByMe ? 'true' : 'false'}" aria-label="Like this post"><svg class="feed-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg> <span data-like-count="${escapeHtml(post.id)}">${escapeHtml(post.likeCount)}</span></button>
          <button type="button" class="feed-action" data-feed-comments="${escapeHtml(post.id)}" aria-label="View comments"><svg class="feed-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg> <span data-comment-count="${escapeHtml(post.id)}">${escapeHtml(post.commentCount)}</span></button>
          <button type="button" class="feed-action" data-feed-copy="${escapeHtml(post.id)}" title="Copy link to this post" aria-label="Copy link to this post"><svg class="feed-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 7h3a5 5 0 0 1 0 10h-3m-6 0H6a5 5 0 0 1 0-10h3"/><line x1="8" y1="12" x2="16" y2="12"/></svg> Link</button>
          ${menu}
        </div>
        <div class="feed-comments" data-comments-for="${escapeHtml(post.id)}" hidden></div>
      </article>`;
  }


  // ---- Feed loading with cursor pagination ----
  async function loadFeed({ append = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    const list = $('feed-list');
    const loadWrap = $('feed-load-more-wrap');
    if (!append) {
      list.innerHTML = '<p class="muted small feed-loading">Loading feed…</p>';
      loadWrap.hidden = true;
    }
    try {
      const params = new URLSearchParams({ filter: state.filter, limit: '15' });
      if (append && state.cursor) params.set('cursor', String(state.cursor));
      const data = await request(`/feed?${params}`);
      state.cursor = data.nextCursor;
      const cards = data.posts.map(post => renderPostCard(post, {
        canManage: post.author.username === state.myUsername,
        isAnnouncement: post.kind === 'announcement'
      }));
      if (append) {
        list.insertAdjacentHTML('beforeend', cards.join(''));
      } else {
        state.posts = data.posts;
        list.innerHTML = cards.length ? cards.join('')
          : '<div class="panel empty-state feed-empty"><span class="empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg></span><h2>No posts yet</h2><p>Be the first to share something with the CornGrid community.</p></div>';
      }
      animateNewChildren(list, '.feed-card', seenPostIds, 'postId');
      loadWrap.hidden = !state.cursor;
      state.loaded = true;
    } catch (error) {
      if (error && error.name === 'AbortError') { state.loading = false; return; }
      if (state.abortController && state.abortController.signal.aborted) { state.loading = false; return; }
      if (!append) {
        list.innerHTML = `<div class="panel empty-state feed-empty"><span class="empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span><h2>Unable to load the feed</h2><p>${escapeHtml(error.message)}</p><button type="button" class="button button-primary" id="feed-retry">Try again</button></div>`;
        const retry = $('feed-retry');
        if (retry) retry.addEventListener('click', () => loadFeed());
      } else {
        toast(error.message, 'error');
      }
    } finally {
      state.loading = false;
    }
  }


  // ---- Composer: create and edit posts ----
  function resetComposer() {
    const input = $('feed-composer-input');
    input.value = '';
    $('feed-char-count').textContent = `0 / ${MAX_POST_LENGTH}`;
    state.editingPostId = null;
    state.composerImage = null;
    $('feed-composer-image').hidden = true;
    $('feed-composer-image-preview').removeAttribute('src');
    $('feed-composer-cancel').hidden = true;
    $('feed-composer-submit').textContent = 'Publish post';
    $('feed-composer-file').value = '';
  }

  function startEditPost(postId) {
    const post = state.posts.find(item => String(item.id) === String(postId))
      || state.profilePosts.find(item => String(item.id) === String(postId));
    if (!post) return;
    state.editingPostId = post.id;
    const input = $('feed-composer-input');
    input.value = post.title ? `${post.title}\n${post.content}` : post.content;
    $('feed-char-count').textContent = `${input.value.length} / ${MAX_POST_LENGTH}`;
    $('feed-composer-cancel').hidden = false;
    $('feed-composer-submit').textContent = 'Save changes';
    // The composer lives inside .feed-layout; if the profile view is open, return to the
    // feed so the user can actually see and edit the populated composer.
    hideProfile();
    input.focus();
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function submitComposer() {
    const input = $('feed-composer-input');
    const raw = input.value.trim();
    if (!raw) return toast('Write something before publishing.', 'error');
    if (raw.length > MAX_POST_LENGTH) return toast(`Posts are limited to ${MAX_POST_LENGTH} characters.`, 'error');
    const button = $('feed-composer-submit');
    if (button.disabled) return; // guard against double-submit
    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = originalLabel === 'Publish post' ? 'Publishing…' : 'Saving…';
    try {
      if (state.editingPostId != null) {
        await request(`/feed/posts/${encodeURIComponent(state.editingPostId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ content: raw })
        });
        toast('Post updated.', 'success');
      } else {
        await request('/feed/posts', {
          method: 'POST',
          body: JSON.stringify({ content: raw, imagePath: state.composerImage })
        });
        toast('Post published.', 'success');
      }
      resetComposer();
      await loadFeed();
      if (state.profile && state.profileTab === 'posts') loadProfile(state.profile.username, { silent: true });
    } catch (error) {
      toast(error.message, 'error');
      // Restore the label only on failure; resetComposer() already set it back
      // to "Publish post" after a successful save.
      button.textContent = originalLabel;
    } finally {
      button.disabled = false;
    }
  }

  async function uploadComposerImage(file) {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      return toast('Only JPEG, PNG, or WebP images are supported.', 'error');
    }
    if (file.size > 5 * 1024 * 1024) return toast('Image must be 5 MB or smaller.', 'error');
    try {
      const response = await fetch(`${API}/feed/uploads`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': file.type },
        body: file,
        signal: AbortSignal.timeout(60000)
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401 || response.status === 403) throw new Error('Your session has expired. Please sign in again.');
      if (!response.ok) throw new Error(data.error || 'The image could not be uploaded.');
      state.composerImage = data.url;
      const preview = $('feed-composer-image-preview');
      preview.src = `${data.url}?v=${Date.now()}`;
      $('feed-composer-image').hidden = false;
    } catch (error) {
      toast(error.message, 'error');
    }
  }


  // ---- Comments: load, render, add, edit, delete ----
  function renderComment(comment, postId, isReply = false) {
    const mine = comment.author.username === state.myUsername;
    const actions = mine
      ? `<button type="button" class="feed-action" data-comment-edit="${escapeHtml(comment.id)}">Edit</button>
         <button type="button" class="feed-action" data-comment-delete="${escapeHtml(comment.id)}" data-comment-post="${escapeHtml(postId)}">Delete</button>`
      : `<button type="button" class="feed-action" data-feed-report="${escapeHtml(comment.id)}" data-report-type="comment">Report</button>`;
    const edited = comment.edited ? '<span class="feed-edited" title="' + escapeHtml(exactTime(comment.createdAt)) + '">· edited</span>' : '';
    const replies = !isReply && Array.isArray(comment.replies) && comment.replies.length
      ? `<div class="feed-replies">${comment.replies.map(reply => renderComment(reply, postId, true)).join('')}</div>`
      : '';
    return `
      <div class="feed-comment${isReply ? ' feed-comment-reply' : ''}" data-comment-id="${escapeHtml(comment.id)}">
        ${CornGridAvatar.html(comment.author, '', 'feed-avatar feed-avatar-sm')}
        <div class="feed-comment-body">
          <div class="feed-comment-bubble">
            <div class="feed-comment-meta">
              <strong>${escapeHtml(comment.author.displayName)}</strong>
              <span class="muted small"><time title="${escapeHtml(exactTime(comment.createdAt))}">${escapeHtml(timeAgo(comment.createdAt))}</time>${edited}</span>
            </div>
            <div class="feed-comment-content">${escapeHtml(comment.content).replace(/\n/g, '<br>')}</div>
          </div>
          <div class="feed-comment-actions">
            <button type="button" class="feed-action feed-action-sm" data-comment-reply="${escapeHtml(comment.id)}" data-comment-post="${escapeHtml(postId)}">Reply</button>
            ${actions}
          </div>
          ${replies}
        </div>
      </div>`;
  }

  async function loadComments(postId) {
    const host = document.querySelector(`[data-comments-for="${CSS.escape(String(postId))}"]`);
    if (!host) return;
    host.hidden = false;
    host.innerHTML = '<p class="muted small feed-loading">Loading comments…</p>';
    try {
      const data = await request(`/feed/posts/${encodeURIComponent(postId)}/comments?limit=20`);
      state.openComments.set(String(postId), data.comments);
      const composer = `
        <form class="feed-comment-form" data-comment-form="${escapeHtml(postId)}">
          <input type="text" class="input-control" maxlength="${MAX_COMMENT_LENGTH}" placeholder="Write a comment…" aria-label="Comment text" required>
          <button type="submit" class="button button-primary button-small">Send</button>
        </form>`;
      host.innerHTML = (data.comments.length
        ? data.comments.map(comment => renderComment(comment, postId)).join('')
        : '<p class="muted small">No comments yet. Start the discussion.</p>') + composer;
      animateNewChildren(host, '.feed-comment', seenCommentIds, 'commentId');
    } catch (error) {
      host.innerHTML = `<p class="muted small">${escapeHtml(error.message)}</p>`;
    }
  }


  async function submitComment(postId, content, parentId = null) {
    const trimmed = String(content || '').trim();
    if (!trimmed) return toast('Write a comment before sending.', 'error');
    if (trimmed.length > MAX_COMMENT_LENGTH) return toast(`Comments are limited to ${MAX_COMMENT_LENGTH} characters.`, 'error');
    try {
      const data = await request(`/feed/posts/${encodeURIComponent(postId)}/comments`, {
        method: 'POST',
        body: JSON.stringify({ content: trimmed, parentId })
      });
      const counter = document.querySelector(`[data-comment-count="${CSS.escape(String(postId))}"]`);
      if (counter) counter.textContent = String(data.commentCount);
      await loadComments(postId);
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function deleteComment(commentId, postId) {
    if (!window.confirm('Delete this comment? This cannot be undone.')) return;
    try {
      const data = await request(`/feed/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' });
      const counter = document.querySelector(`[data-comment-count="${CSS.escape(String(postId))}"]`);
      if (counter) counter.textContent = String(data.commentCount);
      await loadComments(postId);
      toast('Comment deleted.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function editComment(commentId, postId) {
    const host = document.querySelector(`[data-comment-id="${CSS.escape(String(commentId))}"] .feed-comment-content`);
    if (!host) return;
    const existing = host.textContent;
    const replacement = document.createElement('form');
    replacement.className = 'feed-comment-form';
    replacement.innerHTML = `<input type="text" class="input-control" maxlength="${MAX_COMMENT_LENGTH}" aria-label="Edit comment" required><button type="submit" class="button button-primary button-small">Save</button>`;
    replacement.querySelector('input').value = existing;
    host.replaceWith(replacement);
    replacement.querySelector('input').focus();
    replacement.addEventListener('submit', async event => {
      event.preventDefault();
      const value = replacement.querySelector('input').value.trim();
      if (!value) return;
      try {
        await request(`/feed/comments/${encodeURIComponent(commentId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ content: value })
        });
        await loadComments(postId);
        toast('Comment updated.', 'success');
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  }

  // ---- Likes: optimistic update with rollback on failure ----
  async function toggleLike(postId, button) {
    const wasLiked = button.classList.contains('is-active');
    const countEl = document.querySelector(`[data-like-count="${CSS.escape(String(postId))}"]`);
    const previous = countEl ? Number(countEl.textContent) : 0;
    button.classList.toggle('is-active', !wasLiked);
    button.setAttribute('aria-pressed', String(!wasLiked));
    if (countEl) countEl.textContent = String(wasLiked ? previous - 1 : previous + 1);
    try {
      const data = await request(`/feed/posts/${encodeURIComponent(postId)}/like`, { method: wasLiked ? 'DELETE' : 'POST' });
      if (countEl) countEl.textContent = String(data.likeCount);
      button.classList.toggle('is-active', data.liked);
      button.setAttribute('aria-pressed', String(data.liked));
    } catch (error) {
      button.classList.toggle('is-active', wasLiked);
      button.setAttribute('aria-pressed', String(wasLiked));
      if (countEl) countEl.textContent = String(previous);
      toast(error.message, 'error');
    }
  }

  async function deletePost(postId) {
    if (!window.confirm('Delete this post? This cannot be undone.')) return;
    try {
      await request(`/feed/posts/${encodeURIComponent(postId)}`, { method: 'DELETE' });
      const card = document.querySelector(`.feed-card[data-post-id="${CSS.escape(String(postId))}"]`);
      if (card) card.remove();
      toast('Post deleted.', 'success');
      if (state.profile) loadProfile(state.profile.username, { silent: true });
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function copyPostLink(postId) {
    const url = `${window.location.origin}/dashboard.html?post=${encodeURIComponent(postId)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Post link copied.', 'success');
    } catch {
      window.prompt('Copy this post link:', url);
    }
  }

  async function reportContent(targetId, targetType) {
    const reason = window.prompt(`Report this ${targetType}. Describe the issue (max 500 characters):`);
    if (reason === null) return;
    if (!reason.trim()) return toast('A report reason is required.', 'error');
    try {
      await request('/feed/reports', {
        method: 'POST',
        body: JSON.stringify({ targetType, targetId: Number(targetId), reason: reason.trim() })
      });
      toast('Report submitted. An administrator will review it.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  }


  // ---- Profile view ----
  async function loadProfile(username, { silent = false } = {}) {
    if (!username) return;
    if (!silent) $('feed-profile-list').innerHTML = '<p class="muted small feed-loading">Loading profile…</p>';
    try {
      const data = await request(`/feed/profile/${encodeURIComponent(username)}`);
      state.profile = data.profile;
      state.profilePosts = data.posts;
      CornGridAvatar.fill($('feed-profile-avatar'), data.profile);
      $('feed-profile-name').textContent = data.profile.displayName;
      $('feed-profile-username').textContent = `@${data.profile.username}`;
      $('feed-profile-bio').textContent = data.profile.bio || 'No bio yet.';
      const joined = data.profile.joinedAt ? new Date(data.profile.joinedAt).toLocaleDateString() : '—';
      $('feed-profile-meta').textContent = `${data.profile.postCount} posts · ${data.profile.commentCount} comments · Joined ${joined}`;
      if (state.profileTab === 'posts') {
        $('feed-profile-list').innerHTML = data.posts.length
          ? data.posts.map(post => renderPostCard(post, { canManage: post.author.username === state.myUsername })).join('')
          : '<p class="muted small">No posts published yet.</p>';
      } else {
        renderMyActivity();
      }
    } catch (error) {
      $('feed-profile-list').innerHTML = `<p class="muted small">${escapeHtml(error.message)}</p>`;
    }
  }

  async function renderMyActivity() {
    $('feed-profile-list').innerHTML = '<p class="muted small feed-loading">Loading activity…</p>';
    try {
      const data = await request('/feed/my-activity?limit=20');
      state.profileActivity = data.activity;
      $('feed-profile-list').innerHTML = data.activity.length
        ? data.activity.map(item => `
          <div class="feed-activity-item">
            <span class="muted small">Commented · <time title="${escapeHtml(exactTime(item.createdAt))}">${escapeHtml(timeAgo(item.createdAt))}</time>${item.edited ? ' · edited' : ''}</span>
            <div class="feed-comment-content">${escapeHtml(item.content).replace(/\n/g, '<br>')}</div>
            <p class="muted small">on: ${escapeHtml(item.postExcerpt)}…</p>
          </div>`).join('')
        : '<p class="muted small">No comments yet.</p>';
    } catch (error) {
      $('feed-profile-list').innerHTML = `<p class="muted small">${escapeHtml(error.message)}</p>`;
    }
  }

  function showProfile(username) {
    $('feed-profile-view').hidden = false;
    document.querySelector('.feed-layout').hidden = true;
    loadProfile(username);
  }

  function hideProfile() {
    $('feed-profile-view').hidden = true;
    document.querySelector('.feed-layout').hidden = false;
  }

  // ---- Side profile card ----
  async function loadMyProfileSummary() {
    try {
      const me = await request('/me');
      const previousUsername = state.myUsername;
      state.myUsername = me.username;
      CornGridAvatar.fill($('feed-composer-avatar'), me);
      $('feed-side-username').textContent = me.username;
      $('feed-side-bio').textContent = me.bio || 'No bio yet.';
      // /api/me returns created_at (snake_case); fall back to createdAt for safety.
      const joinedValue = me.created_at || me.createdAt;
      $('feed-side-joined').textContent = joinedValue
        ? new Date(joinedValue).toLocaleDateString()
        : '—';
      // Pull real community stats from the public profile endpoint.
      try {
        const profile = await request(`/feed/profile/${encodeURIComponent(me.username)}`);
        $('feed-side-posts').textContent = String(profile.profile.postCount);
        $('feed-side-comments').textContent = String(profile.profile.commentCount);
      } catch { /* non-fatal: keep the zeros already rendered */ }
      // Re-render loaded cards only when the viewer identity just became known
      // (first load); onOpen() already refreshes a loaded feed on every visit.
      if (state.loaded && previousUsername !== state.myUsername) loadFeed();
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      if (state.abortController && state.abortController.signal.aborted) return;
      console.error('Unable to load feed profile summary:', error.message);
    }
  }


  // ---- Event wiring (delegated; bound once) ----
  let eventsBound = false;

  function bindEvents() {
    // Composer
    $('feed-composer-input').addEventListener('input', event => {
      $('feed-char-count').textContent = `${event.target.value.length} / ${MAX_POST_LENGTH}`;
    });
    $('feed-composer-submit').addEventListener('click', submitComposer);
    $('feed-composer-cancel').addEventListener('click', resetComposer);
    $('feed-composer-file').addEventListener('change', event => uploadComposerImage(event.target.files[0]));
    $('feed-composer-image-remove').addEventListener('click', () => {
      state.composerImage = null;
      $('feed-composer-image').hidden = true;
      $('feed-composer-file').value = '';
    });

    // Filters
    $('feed-filters').addEventListener('click', event => {
      const button = event.target.closest('[data-feed-filter]');
      if (!button) return;
      state.filter = button.dataset.feedFilter;
      document.querySelectorAll('#feed-filters .feed-filter').forEach(item => {
        item.classList.toggle('is-active', item === button);
      });
      loadFeed();
    });
    $('feed-load-more').addEventListener('click', () => loadFeed({ append: true }));

    // Delegated clicks across feed cards, comments, and profile list
    document.addEventListener('click', event => {
      const like = event.target.closest('[data-feed-like]');
      if (like) return toggleLike(like.dataset.feedLike, like);
      const comments = event.target.closest('[data-feed-comments]');
      if (comments) {
        const host = document.querySelector(`[data-comments-for="${CSS.escape(comments.dataset.feedComments)}"]`);
        if (host && !host.hidden) { host.hidden = true; return; }
        return loadComments(comments.dataset.feedComments);
      }
      const copy = event.target.closest('[data-feed-copy]');
      if (copy) return copyPostLink(copy.dataset.feedCopy);
      const edit = event.target.closest('[data-feed-edit]');
      if (edit) return startEditPost(edit.dataset.feedEdit);
      const remove = event.target.closest('[data-feed-delete]');
      if (remove) return deletePost(remove.dataset.feedDelete);
      const report = event.target.closest('[data-feed-report]');
      if (report) return reportContent(report.dataset.feedReport, report.dataset.reportType);
      const profile = event.target.closest('[data-feed-profile]');
      if (profile && profile.dataset.feedProfile) return showProfile(profile.dataset.feedProfile);
      const commentEdit = event.target.closest('[data-comment-edit]');
      if (commentEdit) {
        const card = commentEdit.closest('.feed-comment');
        return editComment(commentEdit.dataset.commentEdit, card.closest('.feed-comments').dataset.commentsFor);
      }
      const commentDelete = event.target.closest('[data-comment-delete]');
      if (commentDelete) return deleteComment(commentDelete.dataset.commentDelete, commentDelete.dataset.commentPost);
      const reply = event.target.closest('[data-comment-reply]');
      if (reply) {
        const form = document.querySelector(`[data-comment-form="${CSS.escape(reply.dataset.commentPost)}"] input`);
        if (form) {
          form.focus();
          form.value = `@${reply.closest('.feed-comment').querySelector('strong').textContent} `;
          form.closest('form').dataset.parentId = reply.dataset.commentReply;
        }
      }
    });

    // Comment submit (delegated for dynamically added forms)
    document.addEventListener('submit', event => {
      const form = event.target.closest('[data-comment-form]');
      if (!form) return;
      event.preventDefault();
      const input = form.querySelector('input');
      submitComment(form.dataset.commentForm, input.value, form.dataset.parentId ? Number(form.dataset.parentId) : null).then(() => { input.value = ''; });
    });

    // Profile view
    $('feed-view-profile').addEventListener('click', () => { if (state.myUsername) showProfile(state.myUsername); });
    $('feed-profile-back').addEventListener('click', hideProfile);
    $('feed-profile-tabs').addEventListener('click', event => {
      const button = event.target.closest('[data-profile-tab]');
      if (!button) return;
      state.profileTab = button.dataset.profileTab;
      document.querySelectorAll('#feed-profile-tabs .feed-filter').forEach(item => {
        item.classList.toggle('is-active', item === button);
      });
      if (state.profileTab === 'activity') renderMyActivity();
      else if (state.profile) loadProfile(state.profile.username, { silent: true });
    });
  }

  window.CornGridFeed = {
    refresh() {
      if (state.loaded) loadFeed();
    },
    onOpen() {
      if (state.abortController) state.abortController.abort();
      state.abortController = new AbortController();
      if (!eventsBound) { bindEvents(); eventsBound = true; }
      loadMyProfileSummary();
      loadFeed();
      // Deep link support: /dashboard.html?post=<id> opens that post's comments.
      const postId = new URLSearchParams(window.location.search).get('post');
      if (postId && state.loaded === false) {
        // Feed is loading; highlight after first successful load.
        window.setTimeout(() => {
          const card = document.querySelector(`.feed-card[data-post-id="${CSS.escape(postId)}"]`);
          if (card) {
            card.classList.add('feed-card-highlight');
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const button = card.querySelector('[data-feed-comments]');
            if (button) button.click();
          }
        }, 900);
      }
    },
    onClose() {
      if (state.abortController) { state.abortController.abort(); state.abortController = null; }
      state.loading = false;
    }
  };
})();

