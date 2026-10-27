document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('loginForm');
    const userEmail = document.getElementById('userEmail');
    const userPassword = document.getElementById('userPassword');
    const togglePassword = document.getElementById('togglePassword');
    const alertBox = document.getElementById('alertBox');
    const forgotPasswordBtn = document.getElementById('forgotPasswordBtn');
    const usernameGroup = document.getElementById('usernameGroup');
    const userUsername = document.getElementById('userUsername');
    const rememberGroup = document.getElementById('rememberGroup');
    const rememberMe = document.getElementById('rememberMe');
    const toggleAuthMode = document.getElementById('toggleAuthMode');
    const submitButton = document.getElementById('btnLogin');
    const submitLabel = document.querySelector('#btnLogin span');
    const formTitle = document.querySelector('.form-header h3');
    const formDescription = document.querySelector('.form-header p');
    let isRegister = false;
    const PENDING_EMAIL_KEY = 'corngrid_pending_email';
    const PENDING_EXPIRES_KEY = 'corngrid_verify_expires_at';
    const PENDING_COOLDOWN_KEY = 'corngrid_verify_resend_until';

    function rememberPendingVerification(email, expiresAt, cooldownSeconds) {
        try {
            sessionStorage.setItem(PENDING_EMAIL_KEY, email);
            if (Number.isFinite(Number(expiresAt)) && Number(expiresAt) > Date.now()) {
                sessionStorage.setItem(PENDING_EXPIRES_KEY, String(Number(expiresAt)));
            } else {
                sessionStorage.removeItem(PENDING_EXPIRES_KEY);
            }
            if (Number.isFinite(Number(cooldownSeconds)) && Number(cooldownSeconds) > 0) {
                sessionStorage.setItem(PENDING_COOLDOWN_KEY, String(Date.now() + Number(cooldownSeconds) * 1000));
            } else {
                sessionStorage.removeItem(PENDING_COOLDOWN_KEY);
            }
        } catch {}
    }

    function goToVerification(delayMs) {
        setTimeout(() => {
            window.location.href = '/verify-email';
        }, delayMs);
    }

    if (new URLSearchParams(window.location.search).get('verified') === '1') {
        showAlert('Email verified successfully. You can now sign in.', 'success');
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('verified');
        window.history.replaceState({}, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
    }

    // Check if user is already logged in (remember login for PWA / browser)
    async function checkExistingSession() {
        try {
            const userRes = await fetch('/api/me', { credentials: 'same-origin' });
            if (userRes.ok) {
                window.location.replace('/dashboard.html');
                return;
            }
            const adminRes = await fetch('/api/admin/overview?limit=1', { credentials: 'same-origin' });
            if (adminRes.ok) {
                window.location.replace('/admin.html');
                return;
            }
        } catch {}
    }
    checkExistingSession();

    toggleAuthMode.addEventListener('click', () => {
        isRegister = !isRegister;
        usernameGroup.hidden = !isRegister;
        userUsername.required = isRegister;
        if (rememberGroup) rememberGroup.hidden = isRegister;
        submitLabel.textContent = isRegister ? 'Create Account' : 'Sign In to Terminal';
        formTitle.textContent = isRegister ? 'Create CornGrid Account' : 'Account Login';
        formDescription.textContent = isRegister
            ? 'Create an account to access the CornGrid Terminal Portal.'
            : 'Enter your credentials to access the CornGrid Terminal Portal.';
        toggleAuthMode.textContent = isRegister
            ? 'Already have an account? Sign in'
            : "Don't have an account yet? Sign up";
        alertBox.hidden = true;
    });

    function togglePasswordVisibility() {
        const type = userPassword.getAttribute('type') === 'password' ? 'text' : 'password';
        userPassword.setAttribute('type', type);
        togglePassword.classList.toggle('fa-eye');
        togglePassword.classList.toggle('fa-eye-slash');
        togglePassword.setAttribute('aria-pressed', String(type === 'text'));
        togglePassword.setAttribute('aria-label', type === 'text' ? 'Hide password' : 'Show password');
    }

    togglePassword.setAttribute('role', 'button');
    togglePassword.setAttribute('tabindex', '0');
    togglePassword.setAttribute('aria-label', 'Show password');
    togglePassword.addEventListener('click', togglePasswordVisibility);
    togglePassword.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            togglePasswordVisibility();
        }
    });

    // 2. Handling Login Submit via Fetch API
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (submitButton.disabled) return;
        submitButton.disabled = true;
        submitButton.setAttribute('aria-busy', 'true');
        let redirecting = false;
        
        showAlert('Authenticating with CornGrid Server...', 'info');

        try {
            const response = await fetch(isRegister ? '/api/register' : '/api/login', {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    email: userEmail.value.trim(),
                    password: userPassword.value,
                    ...(isRegister ? { username: userUsername.value.trim() } : { rememberMe: rememberMe ? rememberMe.checked : true })
                })
            });

            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                if (data.code === 'EMAIL_NOT_VERIFIED') {
                    rememberPendingVerification(userEmail.value.trim().toLowerCase());
                    redirecting = true;
                    showAlert('Your email address needs verification. Redirecting...', 'info');
                    goToVerification(800);
                    return;
                }
                if (response.status === 409 && isRegister) {
                    throw new Error('This email or username is already registered. Click "Already have an account? Sign in", or use a different username/email. If you just registered, sign in with your password and you will be sent to the PIN page when needed.');
                }
                throw new Error(data.error || 'Login failed. Please check your credentials.');
            }

            if (isRegister) {
                rememberPendingVerification(
                    userEmail.value.trim().toLowerCase(),
                    data.expiresAt,
                    data.resendCooldownSeconds
                );
                redirecting = true;
                showAlert(
                    data.emailSent === false
                        ? 'Account created, but the email could not be sent. Redirecting to verification...'
                        : 'Account created. Redirecting to email verification...',
                    data.emailSent === false ? 'info' : 'success'
                );
                goToVerification(900);
                return;
            }

            showAlert('Login Successful! Redirecting to Terminal...', 'success');

            const destination = data.user?.role === 'admin' ? '/admin.html' : '/dashboard.html';
            redirecting = true;
            setTimeout(() => {
                window.location.href = destination;
            }, 1200);

        } catch (error) {
            showAlert(error.message, 'error');
        } finally {
            if (!redirecting) {
                submitButton.disabled = false;
                submitButton.removeAttribute('aria-busy');
            }
        }
    });

    // 3. Handling Lupa Kata Laluan (Forgot Password)
    forgotPasswordBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const email = userEmail.value.trim();
        if (!email) {
            showAlert('Enter your registered email first.', 'error');
            userEmail.focus();
            return;
        }
        if (!userEmail.checkValidity()) {
            showAlert('Please enter a valid email address.', 'error');
            userEmail.focus();
            return;
        }

        forgotPasswordBtn.setAttribute('aria-disabled', 'true');
        try {
            const response = await fetch('/api/forgot-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });

            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || 'Unable to request a password recovery.');
            }
            showAlert(data.message || 'If your email is registered, a recovery link will be sent.', 'success');
        } catch (err) {
            showAlert(err.message || 'Failed to request password recovery. Please try again.', 'error');
        } finally {
            forgotPasswordBtn.removeAttribute('aria-disabled');
        }
    });

    // Helper Function untuk Papar Mesej Status
    function showAlert(message, type) {
        alertBox.hidden = false;
        alertBox.textContent = message;
        alertBox.classList.remove('alert-error', 'alert-success', 'alert-info');
        alertBox.classList.add(`alert-${type}`);
    }
});