(function () {
  const status = document.getElementById('oauth-status');
  const banner = document.getElementById('banner');
  const continueLink = document.getElementById('oauth-continue');

  const callbackParams = new URLSearchParams(location.hash.slice(1));
  const callbackCode = callbackParams.get('code');

  function safeNextPath() {
    const next = callbackParams.get('next') || new URLSearchParams(location.search).get('next');
    if (!next || !next.startsWith('/') || next.startsWith('//')) return '/index';
    try {
      return new URL(next, location.origin).origin === location.origin ? next : '/index';
    } catch {
      return '/index';
    }
  }

  history.replaceState(null, '', location.pathname + location.search);
  if (callbackParams.has('error') || new URLSearchParams(location.search).has('error')) {
    status.textContent = 'Google sign-in could not be completed.';
    const message = callbackParams.get('error') === 'account'
      ? 'This Google identity could not be linked to a Tournly account. Try a different Google account or contact support.'
      : callbackParams.get('error') === 'unverified'
        ? 'Google did not confirm a verified email address for this account.'
        : 'Your Google sign-in was cancelled or could not be verified. Please try again.';
    UI.showBanner(banner, message);
    continueLink.hidden = false;
    return;
  }
  if (!callbackCode) {
    status.textContent = 'We could not finish signing you in.';
    UI.showBanner(banner, 'The Google sign-in code is missing. Please start again.');
    continueLink.hidden = false;
    return;
  }

  Api.auth.exchangeGoogleCode(callbackCode)
    .then((result) => {
      if (!result?.token || !result?.user) throw new Error('The server did not return an application session.');
      Session.start(result.token, result.user);
      location.replace(safeNextPath());
    })
    .catch((error) => {
      status.textContent = 'We could not finish signing you in.';
      UI.showBanner(banner, UI.friendlyErrorMessage(error));
      continueLink.hidden = false;
    });
})();
