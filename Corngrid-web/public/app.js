const API_URL = '/api';

// Helper Function: Safely parse the response (prevents 'Unexpected end of JSON input' errors)
async function parseResponse(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (err) {
    return { error: 'Invalid server response format.' };
  }
}

// Helper Function: Save / Remove Token
function saveToken(token, remember = false) {
  if (remember) {
    localStorage.setItem('corngrid_token', token);
    sessionStorage.removeItem('corngrid_token');
  } else {
    sessionStorage.setItem('corngrid_token', token);
    localStorage.removeItem('corngrid_token');
  }
}

function getToken() {
  return localStorage.getItem('corngrid_token') || sessionStorage.getItem('corngrid_token');
}

function removeToken() {
  localStorage.removeItem('corngrid_token');
  sessionStorage.removeItem('corngrid_token');
  localStorage.removeItem('token'); // Fallback for the legacy key
}

// ==========================================================================
// 1. Login / Registration Page Logic (index.html, login.html, OR '/')
// ==========================================================================
if (
  window.location.pathname.endsWith('login.html') ||
  window.location.pathname.endsWith('index.html') ||
  window.location.pathname === '/'
) {
  // A. Main Form (supports the new login.html ID OR the legacy auth-form)
  const loginForm = document.getElementById('loginForm') || document.getElementById('auth-form');
  const userEmailInput = document.getElementById('userEmail') || document.getElementById('email');
  const userPasswordInput = document.getElementById('userPassword') || document.getElementById('password');
  const usernameInput = document.getElementById('username'); // If a registration form exists
  const alertBox = document.getElementById('alertBox') || document.getElementById('message');
  const togglePassword = document.getElementById('togglePassword');
  const forgotPasswordBtn = document.getElementById('forgotPasswordBtn') || document.querySelector('.forgot-link');
  const rememberMeCheckbox = document.getElementById('rememberMe');

  // B. Toggle the password visibility icon (if present)
  if (togglePassword && userPasswordInput) {
    togglePassword.addEventListener('click', () => {
      const type = userPasswordInput.getAttribute('type') === 'password' ? 'text' : 'password';
      userPasswordInput.setAttribute('type', type);
      togglePassword.classList.toggle('fa-eye');
      togglePassword.classList.toggle('fa-eye-slash');
    });
  }

  // C. Login / Registration Form Handling
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const email = userEmailInput ? userEmailInput.value.trim() : '';
      const password = userPasswordInput ? userPasswordInput.value : '';
      const username = usernameInput ? usernameInput.value.trim() : '';
      const remember = rememberMeCheckbox ? rememberMeCheckbox.checked : false;

      // Detect the mode (register if the 'auth-form' username field is visible; otherwise default to login)
      const isRegister = usernameInput && usernameInput.offsetParent !== null;
      const endpoint = isRegister ? '/register' : '/login';
      const payload = isRegister ? { username, email, password } : { email, password };

      showAlert('Please wait while your information is being verified...', 'info');

      try {
        const res = await fetch(API_URL + endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await parseResponse(res);

        if (!res.ok) {
          throw new Error(data.error || `A server error occurred (${res.status}).`);
        }

        if (!isRegister) {
          // Login successful
          saveToken(data.token, remember);
          if (data.user) {
            localStorage.setItem('corngrid_user', JSON.stringify(data.user));
          }
          showAlert('Login successful! Redirecting to the dashboard...', 'success');

          setTimeout(() => {
            window.location.href = 'dashboard.html';
          }, 1000);
        } else {
          // Registration successful
          showAlert(data.message || 'Registration successful! Please log in.', 'success');
        }
      } catch (err) {
        showAlert(err.message, 'error');
      }
    });
  }

  // D. Forgot Password Request
  if (forgotPasswordBtn) {
    forgotPasswordBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const email = prompt('Enter your registered email address to reset your password:');
      if (!email) return;

      try {
        const res = await fetch(API_URL + '/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim() })
        });

        const data = await parseResponse(res);
        alert(data.message || data.error || 'Your request has been submitted.');
      } catch (err) {
        alert('Unable to submit the request. Please try again.');
      }
    });
  }

  // Helper for displaying status messages
  function showAlert(msg, type) {
    if (!alertBox) return;
    alertBox.textContent = msg;
    alertBox.style.display = 'block';

    if (alertBox.classList.contains('alert-box')) {
      alertBox.className = `alert-box alert-${type}`;
    } else {
      alertBox.className = `alert ${type}`;
    }
  }
}

// ==========================================================================
// 2. Dashboard Page Logic (dashboard.html)
// ==========================================================================
if (window.location.pathname.endsWith('dashboard.html')) {
  const token = getToken();

  // Check whether a token exists; if not, redirect to the login page
  if (!token) {
    window.location.href = 'login.html';
  }

  const profileForm = document.getElementById('profile-form');
  const emailInput = document.getElementById('dash-email');
  const usernameInput = document.getElementById('dash-username');
  const bioInput = document.getElementById('dash-bio');
  const logoutBtn = document.getElementById('logout-btn');
  const dashMessage = document.getElementById('dash-message');

  // A. Load User Profile Data
  async function loadProfile() {
    try {
      const res = await fetch(API_URL + '/user/profile', {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      const data = await parseResponse(res);

      if (!res.ok) {
        throw new Error(data.error || 'Your session has expired.');
      }

      if (emailInput) emailInput.value = data.email || '';
      if (usernameInput) usernameInput.value = data.username || '';
      if (bioInput) bioInput.value = data.bio || '';
    } catch (err) {
      removeToken();
      window.location.href = 'login.html';
    }
  }

  // B. Update Profile Dynamically
  if (profileForm) {
    profileForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      try {
        const res = await fetch(API_URL + '/user/profile', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            username: usernameInput.value.trim(),
            bio: bioInput.value.trim()
          })
        });

        const data = await parseResponse(res);
        if (!res.ok) throw new Error(data.error || 'Failed to update profile.');

        showDashMessage(data.message || 'Profile updated successfully!', 'success');
      } catch (err) {
        showDashMessage(err.message, 'error');
      }
    });
  }

  // C. Log Out
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      removeToken();
      window.location.href = 'login.html';
    });
  }

  function showDashMessage(msg, type) {
    if (!dashMessage) return;
    dashMessage.textContent = msg;
    dashMessage.className = `alert alert-${type}`;
    dashMessage.style.display = 'block';
  }

  loadProfile();
}