(function () {
  const message = document.getElementById('verification-message');
  const title = document.getElementById('verification-title');
  const status = document.getElementById('verification-status');
  const statusIcon = document.getElementById('verification-status-icon');
  const button = document.getElementById('verify-button');
  const homeLink = document.getElementById('verification-home-link');
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  history.replaceState(null, '', location.pathname);
  const showState = (state, icon, text) => {
    status.dataset.state = state;
    statusIcon.textContent = icon;
    message.textContent = text;
  };
  if (!token) {
    title.textContent = 'Verification link unavailable';
    showState('error', '!', 'This verification link is missing, invalid, or expired. Request a new email to try again.');
    homeLink.hidden = false;
    return;
  }
  button.hidden = false;
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Verifying…';
    showState('pending', '…', 'Confirming your email address securely.');
    try {
      const result = await Api.auth.verifyEmail(token);
      title.textContent = 'Email verified';
      showState('success', '✓', 'You’re all set. Taking you to Tournly home…');
      button.hidden = true;
      homeLink.hidden = false;
      const verification = { email: result.email, at: Date.now() };
      if (verification.email) {
        try {
          if ('BroadcastChannel' in window) {
            const channel = new BroadcastChannel('tournly:email-verification');
            channel.postMessage({ type: 'verified', email: verification.email });
            channel.close();
          }
        } catch {
          // The storage event below is the cross-tab fallback.
        }
        try {
          localStorage.setItem('tournly:verified-email', JSON.stringify(verification));
        } catch {
          // The home redirect still completes when browser storage is unavailable.
        }
      }
      setTimeout(() => location.replace('/index'), 1400);
    } catch (error) {
      title.textContent = 'We couldn’t verify your email';
      showState('error', '!', UI.friendlyErrorMessage(error));
      button.disabled = false;
      button.textContent = 'Try verification again';
      homeLink.hidden = false;
    }
  });
})();
