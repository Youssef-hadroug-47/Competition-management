(function () {
  const form = document.getElementById('register-form');
  const title = document.getElementById('register-title');
  const intro = document.getElementById('register-intro');
  const verifiedState = document.getElementById('verified-state');
  const verifiedStateMessage = document.getElementById('verified-state-message');
  const banner = document.getElementById('banner');
  const submitBtn = document.getElementById('submit-btn');
  const pendingEmailKey = 'tournly:pending-verification-email';
  const verifiedEmailKey = 'tournly:verified-email';
  let verificationChannel = null;
  try {
    if ('BroadcastChannel' in window) {
      verificationChannel = new BroadcastChannel('tournly:email-verification');
    }
  } catch {
    // Storage events provide the cross-tab fallback.
  }

  if (window.Session.isAuthenticated()) {
    location.replace('/index');
    return;
  }

  function isValidEmail(value) {
    // Deliberately simple — real validation happens server-side; this
    // just catches obvious typos before spending a round trip.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  function readPendingEmail() {
    try {
      return sessionStorage.getItem(pendingEmailKey);
    } catch {
      return null;
    }
  }

  function writePendingEmail(email) {
    try {
      sessionStorage.setItem(pendingEmailKey, email.toLowerCase());
    } catch {
      // Verification still works; only the in-page status sync is unavailable.
    }
  }

  function showVerifiedState(email) {
    const pendingEmail = readPendingEmail();
    if (typeof email !== 'string' || !pendingEmail || email.toLowerCase() !== pendingEmail.toLowerCase()) return;
    try {
      sessionStorage.removeItem(pendingEmailKey);
    } catch {
      // The success UI can still be shown if session storage is disabled.
    }
    form.hidden = true;
    document.querySelectorAll('[data-google-sign-in]').forEach((button) => {
      button.hidden = true;
    });
    intro.hidden = true;
    title.textContent = 'Email verified';
    verifiedStateMessage.textContent = `${email} is verified. Your account is ready to use.`;
    verifiedState.hidden = false;
    if (verificationChannel) verificationChannel.close();
  }

  function handleVerifiedEmail(email) {
    showVerifiedState(email);
  }

  if (verificationChannel) {
    verificationChannel.addEventListener('message', (event) => {
      if (event.data?.type === 'verified') handleVerifiedEmail(event.data.email);
    });
  }
  window.addEventListener('pagehide', () => verificationChannel?.close());
  window.addEventListener('storage', (event) => {
    if (event.key !== verifiedEmailKey || !event.newValue) return;
    try {
      const verification = JSON.parse(event.newValue);
      if (Date.now() - verification.at < 10 * 60 * 1000) handleVerifiedEmail(verification.email);
    } catch {
      // Ignore malformed values from browser storage.
    }
  });
  try {
    const verification = JSON.parse(localStorage.getItem(verifiedEmailKey) || 'null');
    if (verification && Date.now() - verification.at < 10 * 60 * 1000) {
      handleVerifiedEmail(verification.email);
    }
  } catch {
    // Storage may be unavailable in private browsing; the open-tab channel remains usable.
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    UI.showBanner(banner, '');

    const name = form.name.value.trim();
    const email = form.email.value.trim();
    const password = form.password.value;

    if (!name || !email || !password) {
      UI.showBanner(banner, 'Fill in your name, email and password.');
      return;
    }
    if (!isValidEmail(email)) {
      UI.showBanner(banner, 'Enter a valid email address.');
      return;
    }
    if (password.length < 8) {
      UI.showBanner(banner, 'Password must be at least 8 characters.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating account…';

    try {
      const result = await Api.auth.register({ name, email, password });
      form.password.value = '';
      writePendingEmail(email);
      submitBtn.disabled = true;
      submitBtn.textContent = 'Verification email sent';
      UI.flashMessage(result.message || 'Account created. Check your email for a verification link.', 'success');
    } catch (err) {
      UI.showBanner(banner, UI.friendlyErrorMessage(err));
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create account';
      if (err.status === 503) writePendingEmail(email);
    }
  });
})();
