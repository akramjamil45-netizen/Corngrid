(() => {
  let deferredInstallPrompt = null;
  let installNotice = null;
  let updateNotice = null;
  let refreshing = false;

  try {
    localStorage.removeItem('corngrid_token');
    localStorage.removeItem('corngrid_user');
    localStorage.removeItem('token');
    sessionStorage.removeItem('corngrid_token');
  } catch (error) {
    console.error('[CornGrid Auth] Unable to remove legacy browser credentials:', error);
  }

  function makeNotice(title, message, actionLabel, onAction, dismissible = false) {
    const notice = document.createElement('section');
    notice.className = 'pwa-notice';
    notice.setAttribute('role', 'region');
    notice.setAttribute('aria-label', title);
    notice.setAttribute('aria-live', 'polite');

    const copy = document.createElement('div');
    copy.className = 'pwa-notice-copy';
    const heading = document.createElement('strong');
    heading.textContent = title;
    const description = document.createElement('span');
    description.textContent = message;
    copy.append(heading, description);

    const action = document.createElement('button');
    action.type = 'button';
    action.textContent = actionLabel;
    action.addEventListener('click', onAction);
    notice.append(copy, action);

    if (dismissible) {
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'pwa-dismiss';
      dismiss.setAttribute('aria-label', 'Dismiss');
      dismiss.textContent = '×';
      dismiss.addEventListener('click', () => notice.remove());
      notice.append(dismiss);
    }

    document.body.append(notice);
    return notice;
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    if (installNotice) installNotice.remove();
    installNotice = makeNotice(
      'Install CornGrid EA',
      'Add CornGrid to your home screen for a focused, app-like experience.',
      'Install',
      async () => {
        if (!deferredInstallPrompt) return;
        const installPrompt = deferredInstallPrompt;
        deferredInstallPrompt = null;
        try {
          await installPrompt.prompt();
          await installPrompt.userChoice;
        } catch (error) {
          console.error('[CornGrid PWA] Installation prompt failed:', error);
        } finally {
          if (installNotice) installNotice.remove();
          installNotice = null;
        }
      },
      true
    );
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    document.querySelectorAll('.pwa-notice').forEach(notice => notice.remove());
    installNotice = null;
  });

  if (!('serviceWorker' in navigator)) return;

  const pageWasAlreadyControlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!pageWasAlreadyControlled) return;
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      const showUpdateNotice = () => {
        if (!registration.waiting || !navigator.serviceWorker.controller || updateNotice) return;
        updateNotice = makeNotice(
          'CornGrid has an update',
          'Reload when you’re ready to use the latest version.',
          'Reload',
          () => {
            updateNotice.querySelector('button').disabled = true;
            registration.waiting.postMessage({ type: 'SKIP_WAITING' });
          }
        );
      };

      if (registration.waiting) showUpdateNotice();
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed') showUpdateNotice();
        });
      });

      registration.update().catch(error => {
        console.error('[CornGrid PWA] Update check failed:', error);
      });
    } catch (error) {
      console.error('[CornGrid PWA] Service worker registration failed:', error);
    }
  });
})();
