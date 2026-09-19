(function () {
  const { el, clear, showBanner, friendlyErrorMessage } = UI;
  let favoriteTournaments = [];

  const topbarActions = document.getElementById('topbar-actions');
  const banner = document.getElementById('banner');
  const favoritesPanel = document.getElementById('favorites-panel');
  const favoritesBody = document.getElementById('favorites-body');
  const createBody = document.getElementById('create-body');
  const publicBody = document.getElementById('public-body');

  const modal = document.getElementById('create-modal');
  const modalBanner = document.getElementById('create-modal-banner');
  const createForm = document.getElementById('create-form');
  const createSubmit = document.getElementById('create-modal-submit');

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
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: 'New tournament',
          onclick: openCreateModal,
        }),
      ])
    );
  }

  function openCreateModal() {
    createForm.reset();
    showBanner(modalBanner, '');
    modal.hidden = false;
    document.getElementById('ct-name').focus();
  }

  function closeCreateModal() {
    modal.hidden = true;
  }

  document.getElementById('create-modal-cancel').addEventListener('click', closeCreateModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeCreateModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeCreateModal();
  });

  createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    showBanner(modalBanner, '');

    const name = createForm.name.value.trim();
    if (!name) {
      showBanner(modalBanner, 'Name is required.');
      return;
    }

    const payload = {
      name,
      place: createForm.place.value.trim() || undefined,
      visibility: createForm.visibility.value,
      numberOfTeams: createForm.numberOfTeams.value ? Number(createForm.numberOfTeams.value) : undefined,
    };

    createSubmit.disabled = true;
    createSubmit.textContent = 'Creating…';
    try {
      await Api.tournaments.create(payload);
      closeCreateModal();
      showBanner(banner, `“${name}” was created.`, 'success');
      await loadPublicTournaments();
    } catch (err) {
      showBanner(modalBanner, friendlyErrorMessage(err));
    } finally {
      createSubmit.disabled = false;
      createSubmit.textContent = 'Create tournament';
    }
  });

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
    const right = [el('span', { class: `badge ${isPrivate ? 'badge--private' : ''}`, text: isPrivate ? 'Private' : 'Public' })];

    if (Session.isAuthenticated()) {
      const isFollowed = favoriteTournaments.map( tour => tour.id).includes(t.id);
      const followBtn = el('button', { id: t.id, class: 'btn btn--ghost', type: 'button', text: isFollowed ? 'Following' : 'Follow'});
      followBtn.disabled = isFollowed;

      followBtn.addEventListener('click', async () => {
        followBtn.disabled = true;
        followBtn.textContent = 'Following…';
        try {
          await Api.follows.follow(t.id);
          followBtn.textContent = 'Following';
          await loadFavorites();
        } catch (err) {
          showBanner(banner, friendlyErrorMessage(err));
          followBtn.disabled = false;
          followBtn.textContent = 'Follow';
        }
      });
      right.push(followBtn);
    }

    return el('li', { class: 'tournament-row' }, [
      el('a', { class: 'tournament-row__link', href: tournamentHref(t.id) }, [
        el('div', { class: 'tournament-row__name', text: t.name }),
        el('div', { class: 'tournament-row__meta', text: [t.place, t.status].filter(Boolean).join(' · ') }),
      ]),
      el('div', { style: 'display:flex; align-items:center; gap:10px;' }, right),
    ]);
  }

  async function loadPublicTournaments() {
    clear(publicBody);
    publicBody.appendChild(el('p', { class: 'empty-state', text: 'Loading…' }));
    try {
      const data = await Api.tournaments.list();
      const items = (data?.tournaments || []).filter((t) => !t.restricted);
      clear(publicBody);
      if (!items.length) {
        publicBody.appendChild(el('p', { class: 'empty-state', text: 'No public tournaments yet — be the first to create one.' }));
        return;
      }
      publicBody.appendChild(el('ul', { class: 'tournament-list' }, items.map(tournamentRow)));
    } catch (err) {
      clear(publicBody);
      showBanner(banner, friendlyErrorMessage(err));
    }
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
      favoriteTournaments = await Api.follows.listFollowed();
      const items = Array.isArray(favoriteTournaments) ? favoriteTournaments : favoriteTournaments?.tournaments || [];
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
      loadFavorites();
    });

    renderHeader();
    renderCreatePanel();
    await Promise.all([loadPublicTournaments(), loadFavorites()]);
  }

  init();
})();
