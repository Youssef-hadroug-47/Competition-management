(function () {
  const form = document.getElementById('forgot-form');
  const emailInput = document.getElementById('forgot-email');
  const banner = document.getElementById('banner');
  const submitBtn = document.getElementById('submit-btn');
  const success = document.getElementById('forgot-success');
  const successMessage = document.getElementById('forgot-success-message');

  if (window.Session.isAuthenticated()) {
    location.replace('/index');
    return;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    UI.showBanner(banner, '');

    const email = emailInput.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      UI.showBanner(banner, 'Enter a valid email address.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';
    try {
      const result = await Api.auth.forgotPassword(email);
      form.hidden = true;
      successMessage.textContent = result.message
        || 'If an account exists for that address, a password reset link has been sent.';
      success.hidden = false;
    } catch (err) {
      UI.showBanner(banner, UI.friendlyErrorMessage(err));
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send reset link';
    }
  });
})();
