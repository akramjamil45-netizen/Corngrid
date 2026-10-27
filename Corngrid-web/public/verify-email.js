(function () {
    'use strict';

    const STORAGE_EMAIL = 'corngrid_pending_email';
    const STORAGE_EXPIRES = 'corngrid_verify_expires_at';
    const STORAGE_COOLDOWN = 'corngrid_verify_resend_until';
    const OTP_TTL_MS = 10 * 60 * 1000;
    const DEFAULT_COOLDOWN_MS = 60 * 1000;

    const form = document.getElementById('verifyForm');
    const emailGroup = document.getElementById('emailGroup');
    const emailInput = document.getElementById('verifyEmail');
    const maskedEmail = document.getElementById('maskedEmail');
    const alertBox = document.getElementById('alertBox');
    const inputs = Array.from(document.querySelectorAll('.otp-input'));
    const verifyBtn = document.getElementById('verifyBtn');
    const verifyLabel = verifyBtn.querySelector('span');
    const resendBtn = document.getElementById('resendBtn');
    const resendLabel = resendBtn.querySelector('span');
    const resendTimer = document.getElementById('resendTimer');
    const expiryLabel = document.getElementById('expiryLabel');
    const otpFieldset = document.querySelector('.otp-fieldset');

    let email = readStorage(STORAGE_EMAIL) || '';
    let expiresAt = Number(readStorage(STORAGE_EXPIRES)) || 0;
    let cooldownUntil = Number(readStorage(STORAGE_COOLDOWN)) || 0;
    let busy = false;
    let resendBusy = false;
    let autoSubmitTimer = null;
    let clockTimer = null;
    let success = false;

    function readStorage(key) {
        try {
            return window.sessionStorage.getItem(key);
        } catch {
            return null;
        }
    }

    function writeStorage(key, value) {
        try {
            if (value === null || value === undefined || value === '') window.sessionStorage.removeItem(key);
            else window.sessionStorage.setItem(key, String(value));
        } catch {
            // Private browsing can block sessionStorage. The page still works
            // for the current visit; the email field is shown as a fallback.
        }
    }

    function maskEmail(value) {
        if (typeof value !== 'string') return '';
        const at = value.lastIndexOf('@');
        if (at < 1) return '***';
        const local = value.slice(0, at);
        const domain = value.slice(at + 1);
        const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
        return `${visible}***@${domain}`;
    }

    function normalizeEmail(value) {
        return typeof value === 'string' ? value.trim().toLowerCase() : '';
    }

    function isValidEmail(value) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
    }

    function resolveEmail() {
        const typed = normalizeEmail(emailInput.value);
        const value = typed || email;
        if (isValidEmail(value)) {
            email = value;
            writeStorage(STORAGE_EMAIL, email);
            renderEmail();
            return email;
        }
        return '';
    }

    function renderEmail() {
        if (isValidEmail(email)) {
            maskedEmail.textContent = maskEmail(email);
            emailInput.value = email;
            emailGroup.hidden = true;
        } else {
            maskedEmail.textContent = 'your registered email';
            emailGroup.hidden = false;
        }
    }

    function showAlert(message, type) {
        alertBox.hidden = false;
        alertBox.textContent = message;
        alertBox.classList.remove('alert-error', 'alert-success', 'alert-info');
        alertBox.classList.add(`alert-${type}`);
    }

    function hideAlert() {
        alertBox.hidden = true;
        alertBox.textContent = '';
    }

    function formatClock(milliseconds) {
        const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    function updateClock() {
        const now = Date.now();

        if (expiresAt > 0) {
            const remaining = expiresAt - now;
            if (remaining > 0) {
                expiryLabel.classList.remove('is-expired');
                expiryLabel.innerHTML = `PIN expires in <strong>${formatClock(remaining)}</strong>`;
                if (!busy && !success) verifyBtn.disabled = false;
            } else {
                expiryLabel.classList.add('is-expired');
                expiryLabel.textContent = 'PIN expired. Request a new PIN.';
                if (!success) verifyBtn.disabled = true;
            }
        } else if (!success) {
            expiryLabel.classList.remove('is-expired');
            expiryLabel.textContent = 'Request a PIN to continue.';
            verifyBtn.disabled = true;
        }

        if (cooldownUntil > now) {
            const remaining = cooldownUntil - now;
            resendBtn.disabled = true;
            resendLabel.textContent = `Resend in ${formatClock(remaining)}`;
            resendTimer.hidden = false;
            resendTimer.textContent = 'A new PIN can be requested when the timer ends.';
        } else {
            resendBtn.disabled = resendBusy || busy || success;
            resendLabel.textContent = resendBusy ? 'Sending...' : 'Resend PIN';
            resendTimer.hidden = true;
            resendTimer.textContent = '';
        }
    }

    function startClock() {
        if (clockTimer) clearInterval(clockTimer);
        updateClock();
        clockTimer = setInterval(updateClock, 1000);
    }

    function startCooldown(milliseconds) {
        cooldownUntil = Date.now() + Math.max(1000, Number(milliseconds) || DEFAULT_COOLDOWN_MS);
        writeStorage(STORAGE_COOLDOWN, cooldownUntil);
        updateClock();
    }

    function setExpiry(millisecondsFromNow) {
        expiresAt = Date.now() + millisecondsFromNow;
        writeStorage(STORAGE_EXPIRES, expiresAt);
        updateClock();
    }

    function getPin() {
        return inputs.map(input => input.value).join('');
    }

    function clearPin(invalid) {
        for (const input of inputs) {
            input.value = '';
            input.classList.toggle('is-invalid', Boolean(invalid));
            input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
        }
        inputs[0].focus();
    }

    function fillDigits(text, startIndex) {
        const digits = String(text || '').replace(/\D/g, '').slice(0, 6);
        if (!digits) return;
        let index = Math.max(0, Math.min(5, Number(startIndex) || 0));
        if (index > 0 && inputs[index].value) index += 1;
        for (let offset = 0; offset < digits.length && index + offset < 6; offset += 1) {
            inputs[index + offset].value = digits[offset];
        }
        const next = Math.min(5, index + digits.length);
        inputs[next].focus();
        scheduleAutoSubmit();
    }

    function scheduleAutoSubmit() {
        if (autoSubmitTimer) clearTimeout(autoSubmitTimer);
        if (getPin().length !== 6 || busy || success) return;
        autoSubmitTimer = setTimeout(() => {
            autoSubmitTimer = null;
            if (getPin().length === 6 && !busy && !success) submitVerification();
        }, 180);
    }

    function setVerifyBusy(value) {
        busy = value;
        verifyBtn.disabled = value || success || (expiresAt > 0 && expiresAt <= Date.now());
        verifyBtn.classList.toggle('is-busy', value);
        verifyBtn.setAttribute('aria-busy', value ? 'true' : 'false');
        verifyLabel.textContent = value ? 'Verifying...' : 'Verify email';
        const icon = verifyBtn.querySelector('i');
        if (icon) icon.className = value ? 'fas fa-spinner' : 'fas fa-arrow-right';
        if (otpFieldset) otpFieldset.disabled = value || success;
        updateClock();
    }

    function setResendBusy(value) {
        resendBusy = value;
        resendBtn.disabled = value || busy || success || cooldownUntil > Date.now();
        resendLabel.textContent = value ? 'Sending...' : 'Resend PIN';
    }

    async function submitVerification() {
        if (busy || success) return;
        const targetEmail = resolveEmail();
        if (!targetEmail) {
            showAlert('Enter the email address you registered with.', 'error');
            emailInput.focus();
            return;
        }
        const pin = getPin();
        if (!/^\d{6}$/.test(pin)) {
            showAlert('Enter the complete 6-digit PIN.', 'error');
            clearPin(true);
            return;
        }

        hideAlert();
        setVerifyBusy(true);
        try {
            const response = await fetch('/api/verify-email', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: targetEmail, pin })
            });
            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                clearPin(true);
                if (response.status === 429) {
                    showAlert('Too many attempts. Please wait a moment and request a new PIN.', 'error');
                } else {
                    showAlert(data.error || 'The verification PIN is invalid or has expired.', 'error');
                }
                return;
            }

            success = true;
            writeStorage(STORAGE_EMAIL, null);
            writeStorage(STORAGE_EXPIRES, null);
            writeStorage(STORAGE_COOLDOWN, null);
            clearPin(false);
            showAlert('Email verified successfully. Redirecting to sign in...', 'success');
            verifyBtn.disabled = true;
            resendBtn.disabled = true;
            if (otpFieldset) otpFieldset.disabled = true;
            setTimeout(() => {
                window.location.href = '/login.html?verified=1';
            }, 1500);
        } catch {
            clearPin(true);
            showAlert('We could not reach the verification service. Check your connection and try again.', 'error');
        } finally {
            if (!success) setVerifyBusy(false);
        }
    }

    async function resendPin() {
        if (resendBusy || busy || success) return;
        if (cooldownUntil > Date.now()) {
            showAlert(`Please wait ${formatClock(cooldownUntil - Date.now())} before requesting another PIN.`, 'info');
            return;
        }
        const targetEmail = resolveEmail();
        if (!targetEmail) {
            showAlert('Enter the email address you registered with.', 'error');
            emailInput.focus();
            return;
        }

        hideAlert();
        setResendBusy(true);
        try {
            const response = await fetch('/api/resend-verification', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: targetEmail })
            });
            const data = await response.json().catch(() => ({}));

            if (response.status === 429) {
                const retryAfter = Number(response.headers.get('Retry-After'));
                startCooldown((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60) * 1000);
                showAlert(data.error || 'Please wait before requesting another PIN.', 'error');
                return;
            }
            if (!response.ok) {
                showAlert(data.error || 'The PIN could not be sent right now. Please try again.', 'error');
                return;
            }

            clearPin(false);
            setExpiry(OTP_TTL_MS);
            startCooldown(DEFAULT_COOLDOWN_MS);
            showAlert('If this email needs verification, a new PIN has been sent. Check your inbox and spam folder.', 'success');
        } catch {
            showAlert('We could not reach the verification service. Check your connection and try again.', 'error');
        } finally {
            setResendBusy(false);
        }
    }

    inputs.forEach(input => {
        input.addEventListener('input', event => {
            const digits = event.target.value.replace(/\D/g, '');
            event.target.value = digits.slice(0, 1);
            if (digits.length > 1) {
                fillDigits(digits, Number(input.dataset.index));
                return;
            }
            const index = Number(input.dataset.index);
            if (event.target.value && index < inputs.length - 1) inputs[index + 1].focus();
            scheduleAutoSubmit();
        });

        input.addEventListener('keydown', event => {
            const index = Number(input.dataset.index);
            if (event.key === 'Backspace' && !input.value && index > 0) {
                event.preventDefault();
                inputs[index - 1].value = '';
                inputs[index - 1].focus();
            } else if (event.key === 'ArrowLeft' && index > 0) {
                event.preventDefault();
                inputs[index - 1].focus();
            } else if (event.key === 'ArrowRight' && index < inputs.length - 1) {
                event.preventDefault();
                inputs[index + 1].focus();
            } else if (event.key === 'Enter') {
                event.preventDefault();
                submitVerification();
            }
        });

        input.addEventListener('paste', event => {
            event.preventDefault();
            const text = event.clipboardData ? event.clipboardData.getData('text') : '';
            fillDigits(text, Number(input.dataset.index));
        });

        input.addEventListener('focus', () => input.select());
    });

    emailInput.addEventListener('input', () => {
        const value = normalizeEmail(emailInput.value);
        if (isValidEmail(value)) {
            email = value;
            writeStorage(STORAGE_EMAIL, email);
        }
    });

    form.addEventListener('submit', event => {
        event.preventDefault();
        submitVerification();
    });

    resendBtn.addEventListener('click', resendPin);

    renderEmail();
    startClock();
    if (isValidEmail(email)) inputs[0].focus();
    else emailInput.focus();
    window.addEventListener('beforeunload', () => {
        if (clockTimer) clearInterval(clockTimer);
        if (autoSubmitTimer) clearTimeout(autoSubmitTimer);
    });
})();
