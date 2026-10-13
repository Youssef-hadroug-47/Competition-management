(function () {
  const buttons = document.querySelectorAll('[data-google-sign-in]');
  if (!buttons.length) return;
  buttons.forEach((button) => { button.hidden = true; });

  function safeNextPath() {
    const next = new URLSearchParams(location.search).get('next');
    if (!next || !next.startsWith('/') || next.startsWith('//')) return '/index';
    try {
      return new URL(next, location.origin).origin === location.origin ? next : '/index';
    } catch {
      return '/index';
    }
  }

  Api.auth.providers()
    .then((providers) => {
      if (!providers?.google) return;
      buttons.forEach((button) => {
        button.hidden = false;
        button.addEventListener('click', () => {
          button.disabled = true;
          button.textContent = 'Connecting to Google…';
          UI.showBanner(document.getElementById('banner'), '');
          const form = document.createElement('form');
          form.method = 'POST';
          form.action = Api.auth.googleStartUrl();
          form.hidden = true;
          const next = document.createElement('input');
          next.type = 'hidden';
          next.name = 'next';
          next.value = safeNextPath();
          form.appendChild(next);
          document.body.appendChild(form);
          form.submit();
        });
      });
    })
    .catch((error) => {
      UI.showBanner(document.getElementById('banner'), `Google sign-in is unavailable: ${UI.friendlyErrorMessage(error)}`);
    });
})();
