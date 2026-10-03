(function () {
  const form = document.getElementById('register-form');
  const banner = document.getElementById('banner');
  const submitBtn = document.getElementById('submit-btn');

  if (window.Session.isAuthenticated()) {
    location.replace('/index.html');
    return;
  }

  function isValidEmail(value) {
    // Deliberately simple — real validation happens server-side; this
    // just catches obvious typos before spending a round trip.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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
      // Note: this backend's /auth/register accepts an optional `role`
      // field ('user' | 'referee'). We deliberately never send one from
      // this public form — role escalation belongs behind the admin-only
      // PATCH /users/:id/role endpoint, not a self-service signup form.
      const result = await Api.auth.register({ name, email, password });
      window.Session.start(result.token, result.user);
      form.password.value = '';
      location.href = '/index.html';
    } catch (err) {
      UI.showBanner(banner, UI.friendlyErrorMessage(err));
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create account';
    }
  });
})();
