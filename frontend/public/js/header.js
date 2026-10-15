/**
 * header.js — the same topbar (logo + auth-state-dependent actions) on
 * every page. Pulled out of home.js so the tournament page (and any
 * future page) doesn't duplicate the profile-menu logic.
 */
(function () {
  const { el, clear } = window.UI;
  let closeActiveDrawer = null;

  document.addEventListener('keydown', (event) => {
    if (!closeActiveDrawer) return;
    if (event.key === 'Escape') {
      closeActiveDrawer();
      return;
    }
    if (event.key !== 'Tab') return;

    const drawer = document.querySelector('.mobile-nav:not([hidden])');
    if (!drawer) return;
    const focusable = [...drawer.querySelectorAll('a, button')];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!drawer.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

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

  function link(text, href, className) {
    return el('a', { class: className || 'mobile-nav__link', href, text });
  }

  function createMobileNavigation(user) {
    const closeButton = el('button', {
      class: 'mobile-nav__close',
      type: 'button',
      'aria-label': 'Close navigation menu',
      text: '×',
    });
    const links = user
      ? [
          link('Home', '/index'),
          link('Join a team with a code', '/join-team'),
          el('button', { class: 'mobile-nav__link', type: 'button', text: 'Log out', onclick: handleLogout }),
        ]
      : [
          link('Join with code', '/join-team'),
          link('Log in', '/login'),
          link('Register', '/register', 'mobile-nav__link mobile-nav__link--primary'),
        ];

    const drawer = el('aside', {
      class: 'mobile-nav',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Navigation menu',
      hidden: true,
    }, [
      el('div', { class: 'mobile-nav__header' }, [
        el('span', { class: 'mobile-nav__title', text: 'Menu' }),
        closeButton,
      ]),
      user
        ? el('div', { class: 'mobile-nav__account' }, [
            el('strong', { text: user.name || 'Account' }),
            el('span', { text: user.email || '' }),
          ])
        : null,
      el('nav', { class: 'mobile-nav__links', 'aria-label': 'Main navigation' }, links),
    ]);
    const backdrop = el('button', {
      class: 'mobile-nav__backdrop',
      type: 'button',
      'aria-label': 'Close navigation menu',
      hidden: true,
    });

    function close() {
      drawer.hidden = true;
      backdrop.hidden = true;
      document.body.classList.remove('mobile-nav-open');
      closeActiveDrawer = null;
      toggle.setAttribute('aria-expanded', 'false');
      toggle.focus();
    }

    const toggle = el('button', {
      class: 'mobile-nav-toggle',
      type: 'button',
      'aria-label': 'Open navigation menu',
      'aria-controls': 'mobile-navigation',
      'aria-expanded': 'false',
    }, [
      el('span', { class: 'mobile-nav-toggle__icon', 'aria-hidden': 'true' }, [
        el('span'), el('span'), el('span'),
      ]),
      el('span', { class: 'mobile-nav-toggle__text', text: 'Menu' }),
    ]);
    drawer.id = 'mobile-navigation';
    toggle.addEventListener('click', () => {
      drawer.hidden = false;
      backdrop.hidden = false;
      document.body.classList.add('mobile-nav-open');
      toggle.setAttribute('aria-expanded', 'true');
      closeActiveDrawer = close;
      closeButton.focus();
    });
    closeButton.addEventListener('click', close);
    backdrop.addEventListener('click', close);

    return [toggle, backdrop, drawer];
  }

  /**
   * Renders into `container` (cleared first). Safe to call more than once
   * (e.g. after the session changes) — it always reflects current state.
   */
  function render(container) {
    if (closeActiveDrawer) closeActiveDrawer();
    clear(container);
    const user = window.Session.getUser();

    if (!user) {
      container.appendChild(el('div', { class: 'topbar__desktop-actions' }, [
        el('a', { class: 'btn btn--ghost', href: '/join-team', text: 'Join with code' }),
        el('a', { class: 'btn btn--ghost', href: '/login', text: 'Log in' }),
        el('a', { class: 'btn btn--primary', href: '/register', text: 'Register' }),
      ]));
      container.append(...createMobileNavigation(null));
      return;
    }

    const menu = el('div', { class: 'profile__menu', role: 'menu', hidden: true }, [
      el('div', { class: 'profile__menu-name', text: user.name || 'Account' }),
      el('div', { class: 'profile__menu-email', text: user.email || '' }),
      el('button', { type: 'button', text: 'Home', onclick: () => location.href = '/index' }),
      el('button', { type: 'button', text: 'Join a team with a code', onclick: () => location.href = '/join-team' }),
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

    container.appendChild(el('div', { class: 'topbar__desktop-actions' }, [
      el('div', { class: 'profile' }, [button, menu]),
    ]));
    container.append(...createMobileNavigation(user));
  }

  window.Header = { render };
})();
