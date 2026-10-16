document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('loginForm');
    const userEmail = document.getElementById('userEmail');
    const userPassword = document.getElementById('userPassword');
    const togglePassword = document.getElementById('togglePassword');
    const alertBox = document.getElementById('alertBox');
    const forgotPasswordBtn = document.getElementById('forgotPasswordBtn');
    const usernameGroup = document.getElementById('usernameGroup');
    const userUsername = document.getElementById('userUsername');
    const toggleAuthMode = document.getElementById('toggleAuthMode');
    const submitLabel = document.querySelector('#btnLogin span');
    const formTitle = document.querySelector('.form-header h3');
    const formDescription = document.querySelector('.form-header p');
    let isRegister = false;

    toggleAuthMode.addEventListener('click', () => {
        isRegister = !isRegister;
        usernameGroup.hidden = !isRegister;
        userUsername.required = isRegister;
        submitLabel.textContent = isRegister ? 'Create Account' : 'Sign In to Terminal';
        formTitle.textContent = isRegister ? 'Create CornGrid Account' : 'Account Login';
        formDescription.textContent = isRegister
            ? 'Create an account to access the CornGrid Terminal Portal.'
            : 'Enter your credentials to access the CornGrid Terminal Portal.';
        toggleAuthMode.textContent = isRegister
            ? 'Already have an account? Sign in'
            : "Don't have an account yet? Sign up";
        alertBox.style.display = 'none';
    });

    // 1. Function Toggle Buka/Tutup Password Eye Icon
    togglePassword.addEventListener('click', () => {
        const type = userPassword.getAttribute('type') === 'password' ? 'text' : 'password';
        userPassword.setAttribute('type', type);
        togglePassword.classList.toggle('fa-eye');
        togglePassword.classList.toggle('fa-eye-slash');
    });

    // 2. Handling Login Submit via Fetch API
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        showAlert('Authenticating with CornGrid Server...', 'info');

        try {
            const response = await fetch(isRegister ? '/api/register' : '/api/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    email: userEmail.value.trim(),
                    password: userPassword.value,
                    ...(isRegister ? { username: userUsername.value.trim() } : {})
                })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Login failed. Please check your credentials.');
            }

            if (isRegister) {
                showAlert(data.message || 'Account created. Please sign in.', 'success');
                isRegister = false;
                usernameGroup.hidden = true;
                userUsername.required = false;
                submitLabel.textContent = 'Sign In to Terminal';
                formTitle.textContent = 'Account Login';
                formDescription.textContent = 'Enter your credentials to access the CornGrid Terminal Portal.';
                toggleAuthMode.textContent = "Don't have an account yet? Sign up";
                loginForm.reset();
                return;
            }

            // Save the existing JWT token for either a user or administrator session.
            localStorage.setItem('corngrid_token', data.token);
            localStorage.setItem('corngrid_user', JSON.stringify(data.user));

            showAlert('Login Successful! Redirecting to Terminal...', 'success');

            const destination = data.user?.role === 'admin' ? '/admin.html' : '/dashboard.html';
            setTimeout(() => {
                window.location.href = destination;
            }, 1200);

        } catch (error) {
            showAlert(error.message, 'error');
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
        alertBox.style.display = 'block';
        alertBox.textContent = message;

        if (type === 'error') {
            alertBox.style.backgroundColor = '#f8d7da';
            alertBox.style.color = '#721c24';
            alertBox.style.border = '1px solid #f5c6cb';
        } else if (type === 'success') {
            alertBox.style.backgroundColor = '#d4edda';
            alertBox.style.color = '#155724';
            alertBox.style.border = '1px solid #c3e6cb';
        } else {
            alertBox.style.backgroundColor = '#cce5ff';
            alertBox.style.color = '#004085';
            alertBox.style.border = '1px solid #b8daff';
        }
    }
});