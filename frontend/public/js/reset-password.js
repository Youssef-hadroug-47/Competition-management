(function () {
  const form = document.getElementById('reset-form');
  const banner = document.getElementById('banner');
  const submitBtn = document.getElementById('submit-btn');
  const success = document.getElementById('reset-success');
  const help = document.getElementById('reset-help');
  const title = document.getElementById('reset-title');
  const intro = document.getElementById('reset-intro');
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  history.replaceState(null, '', location.pathname);

  function showInvalidLink(message) {
    form.hidden = true;
    title.textContent = 'Reset link unavailable';
    intro.textContent = message;
    help.hidden = false;
  }

  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    showInvalidLink('This password reset link is missing, invalid, or has expired. Request a new one.');
    return;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    UI.showBanner(banner, '');

    const password = form.password.value;
    const confirmation = form.confirm.value;
    if (password.length < 8) {
      UI.showBanner(banner, 'Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmation) {
      UI.showBanner(banner, 'The passwords do not match.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Updating…';
    try {
      await Api.auth.resetPassword(token, password);
      form.password.value = '';
      form.confirm.value = '';
      form.hidden = true;
      success.hidden = false;
      window.Session?.end?.();
    } catch (err) {
      UI.showBanner(banner, UI.friendlyErrorMessage(err));
      if (err.code === 'INVALID_RESET_TOKEN') {
        showInvalidLink(UI.friendlyErrorMessage(err));
        return;
      }
      submitBtn.disabled = false;
      submitBtn.textContent = 'Update password';
    }
  });
})();
