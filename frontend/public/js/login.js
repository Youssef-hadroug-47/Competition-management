(function () {
  const form = document.getElementById('login-form');
  const banner = document.getElementById('banner');
  const submitBtn = document.getElementById('submit-btn');

  // If already signed in, there's nothing to do here.
  if (window.Session.isAuthenticated()) {
    location.replace('/index.html');
    return;
  }

  /**
   * Only ever redirect to a same-origin path we were given, never to an
   * absolute URL — otherwise `?next=` becomes an open-redirect vector.
   */
  function safeNextPath() {
    const params = new URLSearchParams(location.search);
    const next = params.get('next');
    if (!next) return '/index.html';
    if (!next.startsWith('/') || next.startsWith('//')) return '/index.html';
    return next;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    UI.showBanner(banner, '');

    const email = form.email.value.trim();
    const password = form.password.value;

    if (!email || !password) {
      UI.showBanner(banner, 'Enter your email and password.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';

    try {
      const result = await Api.auth.login({ email, password });
      window.Session.start(result.token, result.user);
      form.password.value = ''; // never leave the password sitting in the DOM
      location.href = safeNextPath();
    } catch (err) {
      // The backend intentionally returns the same generic "Invalid
      // credentials" message whether the email or the password was
      // wrong, so we don't re-word it here either — doing so could
      // reveal which one was incorrect.
      UI.showBanner(banner, UI.friendlyErrorMessage(err));
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign in';
    }
  });
})();
