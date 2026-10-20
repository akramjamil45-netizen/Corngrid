/* =========================================
   SERVICE-UNAVAILABLE FALLBACK PAGE
   ========================================= */

(function() {
  'use strict';

  var QUOTES = [
    "The market rewards patience. Progress rewards persistence.",
    "A temporary pause does not erase the progress you've made.",
    "Discipline is built in the moments when nothing moves.",
    "Every setback is a chance to return with greater clarity.",
    "Strong systems recover. Strong minds adapt.",
    "Consistency creates the foundation. Patience gives it time.",
    "You don't need to win every moment to build something meaningful.",
    "Stay focused on the process. Let progress follow.",
    "The best move is sometimes to pause, reassess, and return stronger.",
    "Build with discipline. Trade with intention. Grow with patience."
  ];

  var retryBtn = document.getElementById('retryBtn');
  var retryLabel = document.getElementById('retryLabel');
  var retrySpinner = document.getElementById('retrySpinner');
  var returnBtn = document.getElementById('returnBtn');
  var statusMessage = document.getElementById('statusMessage');
  var connectionRestored = document.getElementById('connectionRestored');
  var quoteText = document.getElementById('quoteText');
  var heading = document.getElementById('heading');
  var supportingMessage = document.getElementById('supportingMessage');

  var returnUrl = null;
  var currentQuoteIndex = -1;
  var refreshTimer = null;
  var isRetrying = false;

  function getReturnUrl() {
    if (!returnUrl) {
      var params = new URLSearchParams(window.location.search);
      returnUrl = params.get('r') || '/';
    }
    return returnUrl;
  }

  function pickQuote(index, total) {
    if (total === 0) {
      quoteText.textContent = 'Stay grounded. The next level is coming.';
      heading.textContent = 'Your foundation is still being built.';
      supportingMessage.textContent =
        'The CornGrid platform is temporarily unavailable while we restore normal service.';
      return;
    }
    var actualIndex = index % total;
    quoteText.textContent = QUOTES[actualIndex];
    currentQuoteIndex = actualIndex;
  }

  function startQuoteRotation() {
    if (refreshTimer) return;
    function rotate() {
      pickQuote(++currentQuoteIndex, QUOTES.length);
    }
    rotate();
    refreshTimer = setInterval(rotate, 14000);
  }

  function stopQuoteRotation() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function showStatus(message, type) {
    statusMessage.textContent = message;
    statusMessage.className = 'status-message' + (type ? ' ' + type : '');
  }

  function showConnectionRestored() {
    connectionRestored.classList.add('visible');
  }

  function hideConnectionRestored() {
    connectionRestored.classList.remove('visible');
  }

  function setRetryState(busy, message) {
    if (busy) {
      retryBtn.disabled = true;
      retrySpinner.style.display = 'inline-block';
      retryLabel.textContent = 'Checking...';
    } else {
      retryBtn.disabled = false;
      retrySpinner.style.display = 'none';
      retryLabel.textContent = message || 'Try Again';
    }
  }

  function resetPage() {
    hideConnectionRestored();
    setRetryState(false, 'Try Again');
    showStatus('', '');
  }

  function checkAvailability() {
    return new Promise(function(resolve) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/health', true);
      xhr.timeout = 3000;
      xhr.onreadystatechange = function() {
        if (xhr.readyState !== 4) return;
        if (xhr.status === 200) {
          try {
            var data = JSON.parse(xhr.responseText);
            resolve({ ok: true, data: data });
          } catch (e) {
            resolve({ ok: false, error: 'Invalid response' });
          }
        } else {
          resolve({ ok: false, status: xhr.status });
        }
      };
      xhr.onerror = function() {
        resolve({ ok: false, error: 'Network error' });
      };
      xhr.ontimeout = function() {
        resolve({ ok: false, error: 'Timeout' });
      };
      xhr.send();
    });
  }

  async function handleRetry() {
    if (isRetrying) return;
    isRetrying = true;
    resetPage();
    showStatus('Checking service availability...', '');

    try {
      var result = await checkAvailability();
      if (result.ok) {
        setRetryState(true, 'Checking...');
        showStatus('Connection restored. Redirecting to login...', '');
        showConnectionRestored();
        setTimeout(function() {
          window.location.href = '/login';
        }, 1600);
      } else {
        setRetryState(false, 'Service unavailable');
        var message = 'The service is still unavailable. Please try again shortly.';
        if (result.error) {
          if (result.error === 'Timeout') {
            message = 'The connection timed out. Please try again shortly.';
          } else if (result.error === 'Network error') {
            message = 'Could not reach the server. Please check your internet connection and try again.';
          }
        }
        showStatus(message, 'error');
      }
    } catch (err) {
      setRetryState(false, 'Service unavailable');
      showStatus('An unexpected error occurred. Please try again manually.', 'error');
    } finally {
      isRetrying = false;
    }
  }

  function handleReturn() {
    var url = getReturnUrl();
    var destination = '/';
    try {
      destination = decodeURIComponent(url);
      if (!destination.startsWith('/') || destination.startsWith('//')) {
        destination = '/';
      }
    } catch (e) {
      destination = '/';
    }
    window.location.href = destination;
  }

  pickQuote(0, QUOTES.length);
  startQuoteRotation();

  retryBtn.addEventListener('click', handleRetry);
  returnBtn.addEventListener('click', handleReturn);

  window.addEventListener('beforeunload', function() {
    stopQuoteRotation();
  });
})();
