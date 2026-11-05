(() => {
  if (window.__cornGridPwa) return;
  window.__cornGridPwa = true;
  let deferredInstallPrompt = null;
  let installNotice = null;
  let updateNotice = null;
  let refreshing = false;
  let installationConfirmed = false;
  const dismissalKey = 'corngrid_install_dismissed_until';
  const installed = () => installationConfirmed || navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const dismissed = () => { try { return Number(localStorage.getItem(dismissalKey)) > Date.now(); } catch { return false; } };
  const rememberDismissal = () => { try { localStorage.setItem(dismissalKey, String(Date.now() + 7 * 86400000)); } catch {} };
  const installCopy = () => document.documentElement.lang.match(/^(ms|bm)/) ? {
    title: 'Pasang Aplikasi CornGrid', message: 'Akses CornGrid Infrastructure dan Trading Terminal dengan lebih mudah melalui aplikasi web pada peranti anda.',
    install: 'Pasang', later: 'Bukan Sekarang', manual: 'Cara Memasang', instructions: 'Dalam Safari, tekan Kongsi, kemudian pilih Tambah ke Skrin Utama.'
  } : {
    title: 'Install CornGrid App', message: 'Access CornGrid Infrastructure and Trading Terminal conveniently through the CornGrid web app.',
    install: 'Install', later: 'Not Now', manual: 'How to Install', instructions: 'In Safari, tap Share, then choose Add to Home Screen.'
  };
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const iosSafari = ios && /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent);

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

  function showInstallNotice(manual = false) {
    if (installed() || dismissed() || installNotice || (!manual && !deferredInstallPrompt)) return;
    const copy = installCopy();
    installNotice = makeNotice(copy.title, copy.message, manual ? copy.manual : copy.install,
      async () => {
        if (manual) {
          installNotice.querySelector('.pwa-notice-copy span').textContent = installCopy().instructions;
          installNotice.querySelector('button').hidden = true;
          return;
        }
        if (!deferredInstallPrompt) return;
        installNotice.querySelector('button').disabled = true;
        const installPrompt = deferredInstallPrompt;
        deferredInstallPrompt = null;
        try {
          await installPrompt.prompt();
          const choice = await installPrompt.userChoice;
          if (choice.outcome === 'dismissed') rememberDismissal();
        } catch (error) {
          console.error('[CornGrid PWA] Installation prompt failed:', error);
        } finally {
          if (installNotice) installNotice.remove();
          installNotice = null;
        }
      },
      false
    );
    installNotice.dataset.pwaInstall = manual ? 'manual' : 'native';
    const later = document.createElement('button');
    later.type = 'button'; later.className = 'pwa-dismiss'; later.textContent = copy.later;
    later.addEventListener('click', () => { rememberDismissal(); installNotice.remove(); installNotice = null; });
    installNotice.append(later);
  }
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    showInstallNotice();
  });
  new MutationObserver(() => {
    if (!installNotice) return;
    const copy = installCopy();
    installNotice.setAttribute('aria-label', copy.title);
    installNotice.querySelector('strong').textContent = copy.title;
    const action = installNotice.querySelector('button');
    installNotice.querySelector('.pwa-notice-copy span').textContent = action.hidden ? copy.instructions : copy.message;
    action.textContent = installNotice.dataset.pwaInstall === 'manual' ? copy.manual : copy.install;
    installNotice.querySelector('.pwa-dismiss').textContent = copy.later;
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  if (iosSafari) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => showInstallNotice(true), { once: true });
    else showInstallNotice(true);
  }

  window.addEventListener('appinstalled', () => {
    installationConfirmed = true;
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
