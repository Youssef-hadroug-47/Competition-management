/**
 * header.js — the same topbar (logo + auth-state-dependent actions) on
 * every page. Pulled out of home.js so the tournament page (and any
 * future page) doesn't duplicate the profile-menu logic.
 */
(function () {
  const { el, clear } = window.UI;

  function initials(name) {
    if (!name) return '?';
    return name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('');
  }

  function handleLogout() {
    window.Session.end();
    // Full navigation (not a soft re-render) so every in-memory bit of
    // state from the previous session is discarded, not just the token.
    location.href = '/index';
  }

  /**
   * Renders into `container` (cleared first). Safe to call more than once
   * (e.g. after the session changes) — it always reflects current state.
   */
  function render(container) {
    clear(container);
    const user = window.Session.getUser();

    if (!user) {
      container.appendChild(
        el('div', { class: 'topbar__actions' }, [
          el('a', { class: 'btn btn--ghost', href: '/login', text: 'Log in' }),
          el('a', { class: 'btn btn--primary', href: '/register', text: 'Register' }),
        ])
      );
      return;
    }

    const menu = el('div', { class: 'profile__menu', role: 'menu', hidden: true }, [
      el('div', { class: 'profile__menu-name', text: user.name || 'Account' }),
      el('div', { class: 'profile__menu-email', text: user.email || '' }),
      el('button', { type: 'button', text: 'Home', onClick: () => location.href = '/index' }),
      el('button', { type: 'button', text: 'Log out', onclick: handleLogout }),
    ]);

    const button = el('button', {
      class: 'profile__button',
      type: 'button',
      'aria-haspopup': 'true',
      'aria-expanded': 'false',
      text: initials(user.name || user.email),
      onclick: () => {
        const isHidden = menu.hidden;
        menu.hidden = !isHidden;
        button.setAttribute('aria-expanded', String(isHidden));
      },
    });

    document.addEventListener('click', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && e.target !== button) {
        menu.hidden = true;
        button.setAttribute('aria-expanded', 'false');
      }
    });

    container.appendChild(el('div', { class: 'profile' }, [button, menu]));
  }

  window.Header = { render };
})();
