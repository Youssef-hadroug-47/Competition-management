(function () {
  const { el, clear, showBanner, friendlyErrorMessage } = UI;
  let favoriteTournaments = [];
  let publicTournaments = [];
  const navigationState = UI.pageState('home');

  const topbarActions = document.getElementById('topbar-actions');
  const banner = document.getElementById('banner');
  const favoritesPanel = document.getElementById('favorites-panel');
  const favoritesBody = document.getElementById('favorites-body');
  const myTournamentsPanel = document.getElementById('my-tournaments-panel');
  const myTournamentsBody = document.getElementById('my-tournaments-body');
  const createBody = document.getElementById('create-body');
  const publicBody = document.getElementById('public-body');

  let cancelExpiryTimer = () => {};

  // ---------------------------------------------------------------
  // Header: login/register buttons (left wireframe) vs profile menu
  // (right wireframe) — shared with tournament via header.js
  // ---------------------------------------------------------------
  function renderHeader() {
    Header.render(topbarActions);
  }

  // ---------------------------------------------------------------
  // "création des tournois" panel
  // ---------------------------------------------------------------
  function renderCreatePanel() {
    clear(createBody);
    if (!Session.isAuthenticated()) {
      createBody.appendChild(
        el('div', {}, [
          el('p', { text: 'Sign in to set up your own tournament — brackets, groups, matches and all.' }),
          el('a', { class: 'btn btn--primary', href: '/login', text: 'Log in to create one' }),
        ])
      );
      return;
    }
    createBody.appendChild(
      el('div', {}, [
        el('p', { text: 'Give it a name and you can add stages, teams and players afterwards.' }),
        el('a', { class: 'btn btn--primary', href: '/create-tournament.html', text: 'New tournament' }),
      ])
    );
  }

  // ---------------------------------------------------------------
  // "des tournois publiques"
  // ---------------------------------------------------------------
  // Every place a tournament is shown links to its detail page — this is
  // the one function that builds that link, so the URL shape only lives
  // in one place. `id` comes back from our own API responses, but we
  // still encode it before it ever touches a URL, on general principle.
  function tournamentHref(id) {
    return `/tournament?id=${encodeURIComponent(id)}`;
  }

  function tournamentRow(t) {
    const isPrivate = t.visibility === 'private' || t.restricted;
    const right = [el('span', {
      class: `badge ${isPrivate ? 'badge--private' : ''}`,
      text: isPrivate ? (t.locked ? 'Locked · Private' : 'Private') : 'Public',
    })];

    if (Session.isAuthenticated()) {
      const isFollowed = favoriteTournaments.map( tour => tour.id).includes(t.id);
      const followBtn = el('button', {
        id: t.id,
        class: 'btn btn--ghost',
        type: 'button',
        text: isFollowed ? 'Following' : 'Follow',
      });
      followBtn.disabled = isFollowed;

      followBtn.addEventListener('click', async () => {
        followBtn.disabled = true;
        followBtn.textContent = isPrivate ? 'Requesting…' : 'Following…';
        try {
          const data = await Api.follows.follow(t.id);
          const pending = data?.follow?.status === 'pending';
          followBtn.textContent = pending ? 'Request pending' : 'Following';
          if (!pending) await loadFavorites();
        } catch (err) {
          showBanner(banner, friendlyErrorMessage(err));
          followBtn.disabled = false;
          followBtn.textContent = 'Follow';
        }

      });
      right.push(followBtn);
    }

    const row = el('li', { class: `tournament-row${t.locked ? ' tournament-row--locked' : ''}` }, [
      el('a', { class: 'tournament-row__link', href: tournamentHref(t.id) }, [
        el('div', { class: 'tournament-row__name', text: t.name }),
        el('div', {
          class: 'tournament-row__meta',
          text: [t.place, t.status, t.locked ? 'Inspection access required' : null].filter(Boolean).join(' · '),
        }),
      ]),
      el('div', { style: 'display:flex; align-items:center; gap:10px;' }, right),
    ]);
    row.dataset.tournamentId = t.id;
    return row;
  }

  function renderPublicList(items) {
    clear(publicBody);
    if (!items.length) {
      publicBody.appendChild(el('p', { class: 'empty-state', text: 'No public tournaments yet — be the first to create one.' }));
      return;
    }
    publicBody.appendChild(el('ul', { class: 'tournament-list' }, items.map(tournamentRow)));
  }

  function highlightTournament(tournamentId) {
    const row = [...publicBody.querySelectorAll('[data-tournament-id]')]
      .find((item) => item.dataset.tournamentId === tournamentId);
    if (!row) return;
    row.classList.remove('tournament-row--search-hit');
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    requestAnimationFrame(() => row.classList.add('tournament-row--search-hit'));
  }

  function myTournamentCard(t) {
    const visibility = t.visibility === 'private' ? 'Private' : 'Public';
    return el('li', { class: 'tournament-row' }, [
      el('a', { class: 'tournament-row__link', href: tournamentHref(t.id) }, [
        el('div', { class: 'tournament-row__name', text: t.name }),
        el('div', {
          class: 'tournament-row__meta',
          text: [t.place, t.status, visibility].filter(Boolean).join(' · '),
        }),
      ]),
      el('span', { class: `badge ${t.visibility === 'private' ? 'badge--private' : ''}`, text: visibility }),
    ]);
  }

  async function loadMyTournaments() {
    if (!Session.isAuthenticated()) {
      myTournamentsPanel.hidden = true;
      return;
    }
    myTournamentsPanel.hidden = false;
    clear(myTournamentsBody);
    myTournamentsBody.appendChild(el('p', { class: 'empty-state', text: 'Loading…' }));
    try {
      const data = await Api.tournaments.mine();
      const items = data?.tournaments || [];
      clear(myTournamentsBody);
      myTournamentsBody.appendChild(items.length
        ? el('ul', { class: 'tournament-list' }, items.map(myTournamentCard))
        : el('p', { class: 'empty-state', text: 'You do not own or moderate any tournaments yet.' }));
    } catch (err) {
      clear(myTournamentsBody);
      myTournamentsBody.appendChild(el('p', { class: 'empty-state', text: friendlyErrorMessage(err) }));
    }
  }
  async function loadPublicTournaments() {
    clear(publicBody);
    publicBody.appendChild(el('p', { class: 'empty-state', text: 'Loading…' }));
    try {
      const data = await Api.tournaments.list();
      const items = (data?.tournaments || []).filter((t) => t.visibility !== 'private' && !t.restricted);
      publicTournaments = items;
      renderPublicList(items);
    } catch (err) {
      clear(publicBody);
      showBanner(banner, friendlyErrorMessage(err));
    }
  }

  function setupTournamentSearch() {
    const form = document.getElementById('tournament-search-form');
    const input = document.getElementById('tournament-search-input');
    const result = document.getElementById('tournament-search-result');
    if (!form || !input || !result) return;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      clear(result);
      result.appendChild(el('p', { class: 'empty-state', text: 'Searching…' }));
      const cached = publicTournaments.find((tournament) => tournament.name === name);
      if (cached) {
        clear(result);
        highlightTournament(cached.id);
        return;
      }
      try {
        const data = await Api.tournaments.searchByName(name);
        clear(result);
        if (!data?.tournament) {
          result.appendChild(el('p', { class: 'empty-state', text: 'No tournament has that exact name.' }));
          return;
        }
        const fetched = { ...data.tournament, locked: Boolean(data.locked) };
        if (!publicTournaments.some((tournament) => tournament.id === fetched.id)) {
          publicTournaments = [...publicTournaments, fetched];
          renderPublicList(publicTournaments);
        }
        highlightTournament(fetched.id);
      } catch (err) {
        clear(result);
        if (err.status === 404) {
          result.appendChild(el('p', { class: 'empty-state', text: 'No tournament has that exact name.' }));
        } else {
          result.appendChild(el('p', { class: 'empty-state', text: friendlyErrorMessage(err) }));
          showBanner(banner, friendlyErrorMessage(err));
        }
      }
    });
  }

  // ---------------------------------------------------------------
  // "les tournois favoris" — authenticated only.
  // Backed by GET /tournaments/followed (returns the current user's
  // followed tournaments directly — no per-tournament follow-status
  // lookup needed).
  // ---------------------------------------------------------------
  function favoriteCard(t) {
    const unfollowBtn = el('button', {
      class: 'btn btn--ghost',
      type: 'button',
      text: 'Unfollow',
      style: 'margin-top:10px; width:100%;',
    });
    unfollowBtn.addEventListener('click', async () => {
      unfollowBtn.disabled = true;
      unfollowBtn.textContent = 'Unfollowing…';

      const tourBtn = document.querySelector(`#public-body [id="${t.id}"]`);
      if (tourBtn) {
        tourBtn.textContent = 'Follow';
        tourBtn.disabled = false;
      }

      try {
        await Api.follows.unfollow(t.id);
        await loadFavorites();
      } catch (err) {
        showBanner(banner, friendlyErrorMessage(err));
        unfollowBtn.disabled = false;
        unfollowBtn.textContent = 'Unfollow';
      }
    });

    return el('div', { class: 'favorite-card' }, [
      el('a', { class: 'tournament-row__link', href: tournamentHref(t.id) }, [
        el('div', { class: 'tournament-row__name', text: t.name }),
        el('div', { class: 'tournament-row__meta', text: [t.place, t.status].filter(Boolean).join(' · ') }),
      ]),
      unfollowBtn,
    ]);
  }

  async function loadFavorites() {
    if (!Session.isAuthenticated()) {
      favoritesPanel.hidden = true;
      return;
    }
    favoritesPanel.hidden = false;
    clear(favoritesBody);
    favoritesBody.appendChild(el('p', { class: 'empty-state', text: 'Loading…' }));
    try {
      const followed = await Api.follows.listFollowed();
      const items = Array.isArray(followed) ? followed : followed?.tournaments || [];
      favoriteTournaments = items;
      clear(favoritesBody);
      if (!items.length) {
        favoritesBody.appendChild(
          el('p', { class: 'empty-state', text: 'You\u2019re not following any tournaments yet.' })
        );
        return;
      }
      favoritesBody.appendChild(el('div', { class: 'favorites-strip' }, items.map(favoriteCard)));
    } catch (err) {
      clear(favoritesBody);
      showBanner(banner, friendlyErrorMessage(err));
    }
  }

  // ---------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------
  async function init() {
    cancelExpiryTimer = Session.scheduleExpiryLogout(() => {
      showBanner(banner, 'You were signed out because your session expired.', 'error');
      renderHeader();
      renderCreatePanel();
      setupTournamentSearch();
      loadFavorites();
      loadMyTournaments();
    });

    renderHeader();
    renderCreatePanel();
    // Load followed tournaments first so public rows are rendered with the
    // current follow state instead of the initial empty array. The two
    // requests used to race, leaving public-row buttons stale on first load.
    setupTournamentSearch();
    await loadFavorites();
    await loadMyTournaments();
    await loadPublicTournaments();
    navigationState.restoreScroll();
  }

  init();
})();
