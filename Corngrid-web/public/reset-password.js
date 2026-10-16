document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('resetForm');
  const passwordInput = document.getElementById('newPassword');
  const confirmInput = document.getElementById('confirmPassword');
  const alertBox = document.getElementById('resetAlert');
  const submitButton = document.getElementById('resetSubmit');
  const token = new URLSearchParams(window.location.search).get('token');

  if (token) {
    window.history.replaceState({}, document.title, window.location.pathname);
  } else {
    showMessage('The reset link is invalid or has expired.', 'error');
    submitButton.disabled = true;
  }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
    if (!token) return;

    if (passwordInput.value.length < 8) {
      showMessage('The new password must be at least 8 characters long.', 'error');
      return;
    }
    if (passwordInput.value !== confirmInput.value) {
      showMessage('The new password and confirmation do not match.', 'error');
      return;
    }

    submitButton.disabled = true;
    try {
      const response = await fetch('/api/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: passwordInput.value })
      });

      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error('Invalid server response. Please try again.');
      }

      if (!response.ok) {
        throw new Error(data.error || 'Failed to update password.');
      }

      form.reset();
      showMessage(data.message || 'Password updated successfully.', 'success');
    } catch (error) {
      showMessage(error.message || 'Network error. Please try again.', 'error');
      submitButton.disabled = false;
    }
  });

  function showMessage(message, type) {
    alertBox.textContent = message;
    alertBox.className = `alert-box alert-${type}`;
    alertBox.style.display = 'block';
  }
});
