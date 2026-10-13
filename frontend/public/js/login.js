(function () {
  const form = document.getElementById('login-form');
  const resendForm = document.getElementById('resend-form');
  const resendEmail = document.getElementById('resend-email');
  const banner = document.getElementById('banner');
  const submitBtn = document.getElementById('submit-btn');

  // If already signed in, there's nothing to do here.
  if (window.Session.isAuthenticated()) {
    location.replace('/index');
    return;
  }

  /**
   * Only ever redirect to a same-origin path we were given, never to an
   * absolute URL — otherwise `?next=` becomes an open-redirect vector.
   */
  function safeNextPath() {
    const params = new URLSearchParams(location.search);
    const next = params.get('next');
    if (!next) return '/index';
    if (!next.startsWith('/') || next.startsWith('//')) return '/index';
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
      UI.showBanner(banner, UI.friendlyErrorMessage(err));
      if (err.status === 403) {
        resendEmail.value = email;
        resendForm.hidden = false;
      }
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign in';
    }
  });

  resendForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const result = await Api.auth.resendVerification(resendEmail.value.trim());
      UI.flashMessage(result.message, 'success');
    } catch (err) {
      UI.showBanner(banner, UI.friendlyErrorMessage(err));
    }
  });
})();
