/* ---------------------------------------------------------------------
 * views.js — one render function per screen. Every view function takes
 * a container element (and route params) and populates it, wiring up
 * its own event listeners and API calls. No framework, just DOM.
 * ------------------------------------------------------------------- */

/* ============================= AUTH ================================ */

function viewLogin(container) {
  container.innerHTML = `
    <div class="auth-wrap">
      <h1>🏆 Tournament Manager</h1>
      <p class="center muted">API test console — sign in</p>
      <div class="card">
        <form id="login-form" class="stack">
          <div class="field"><label>Email</label><input type="email" id="li-email" required></div>
          <div class="field"><label>Password</label><input type="password" id="li-pass" required></div>
          <button class="primary" type="submit" style="width:100%">Log in</button>
        </form>
        <p class="hint" style="margin-top:12px">
          Seeded accounts (run <code>npm run seed</code> on the backend):<br>
          admin@tournament.local / admin123 — admin<br>
          referee@tournament.local / referee123 — referee<br>
          user@tournament.local / user123 — user
        </p>
      </div>
      <p class="center">No account? <button class="link-btn" id="go-register">Register</button></p>
    </div>`;

  UI.qs('#go-register', container).addEventListener('click', () => go('#/register'));
  const form = UI.qs('#login-form', container);
  const btn = form.querySelector('button[type=submit]');
  form.addEventListener('submit', UI.guard(btn, async (e) => {
    e.preventDefault();
    const email = UI.qs('#li-email', form).value.trim();
    const password = UI.qs('#li-pass', form).value;
    const res = await API.auth.login({ email, password });
    API.setToken(res.token);
    API.setUser(res.user);
    UI.toast(`Welcome back, ${res.user.name}`, 'success');
    go('#/tournaments');
    route();
  }));
}

function viewRegister(container) {
  container.innerHTML = `
    <div class="auth-wrap">
      <h1>🏆 Tournament Manager</h1>
      <p class="center muted">Create an account</p>
      <div class="card">
        <form id="reg-form" class="stack">
          <div class="field"><label>Name</label><input type="text" id="r-name" required></div>
          <div class="field"><label>Email</label><input type="email" id="r-email" required></div>
          <div class="field"><label>Password</label><input type="password" id="r-pass" required minlength="6"></div>
          <div class="field"><label>Role</label>
            <select id="r-role">
              <option value="user">user (fan / follower)</option>
              <option value="referee">referee</option>
            </select>
          </div>
          <button class="primary" type="submit" style="width:100%">Register</button>
        </form>
        <p class="hint" style="margin-top:12px">
          The API only allows self-registering as <code>user</code> or <code>referee</code>.
          <code>admin</code> accounts come from the seed script or from another admin
          promoting you in Admin → Users.
        </p>
      </div>
      <p class="center">Already have an account? <button class="link-btn" id="go-login">Log in</button></p>
    </div>`;

  UI.qs('#go-login', container).addEventListener('click', () => go('#/login'));
  const form = UI.qs('#reg-form', container);
  const btn = form.querySelector('button[type=submit]');
  form.addEventListener('submit', UI.guard(btn, async (e) => {
    e.preventDefault();
    const body = {
      name: UI.qs('#r-name', form).value.trim(),
      email: UI.qs('#r-email', form).value.trim(),
      password: UI.qs('#r-pass', form).value,
      role: UI.qs('#r-role', form).value,
    };
    const res = await API.auth.register(body);
    API.setToken(res.token);
    API.setUser(res.user);
    UI.toast(`Account created — welcome, ${res.user.name}`, 'success');
    go('#/tournaments');
    route();
  }));
}

/* ========================= TOURNAMENT LIST ========================== */

function tournamentCardHtml(t) {
  if (t.restricted) {
    return `<div class="card tourn-card"><h3>${UI.esc(t.name)}</h3><p class="muted">🔒 Private tournament</p></div>`;
  }
  return `
    <div class="card tourn-card" data-open-t="${t.id}">
      <h3>${UI.esc(t.name)}</h3>
      <p class="muted">${UI.esc(t.place || 'No location set')}</p>
      <div class="row" style="margin-top:8px">
        ${UI.statusBadge(t.status)}
        <span class="badge" style="background:#26314a">${UI.esc(t.format)}</span>
        ${t.visibility === 'private' ? '<span class="badge" style="background:#3a2030">private</span>' : ''}
      </div>
    </div>`;
}

async function viewTournamentList(container) {
  container.innerHTML = '<p class="empty">Loading tournaments…</p>';
  let data;
  try {
    data = await API.tournaments.list();
  } catch (err) {
    container.innerHTML = `<div class="error-box">${UI.esc(UI.errorMessage(err))}</div>`;
    return;
  }
  const canCreate = API.hasRole('admin');
  container.innerHTML = `
    <div class="row between">
      <h1>Tournaments</h1>
      ${canCreate ? '<button class="primary" id="new-t-btn">+ New tournament</button>' : ''}
    </div>
    ${canCreate ? '' : '<p class="hint">Only admins can create tournaments. Log in as an admin (or ask one to promote you in Admin → Users) to try the creation wizard.</p>'}
    <div class="grid cols-3" id="t-grid">
      ${data.tournaments.length ? data.tournaments.map(tournamentCardHtml).join('') : '<p class="empty">No tournaments yet.</p>'}
    </div>`;

  if (canCreate) UI.qs('#new-t-btn', container).addEventListener('click', () => go('#/tournaments/new'));
  UI.qsa('[data-open-t]', container).forEach((c) =>
    c.addEventListener('click', () => go(`#/tournaments/${c.dataset.openT}`))
  );
}

/* ======================== FORMAT / STAGE HELPERS ===================== */

function defaultStageSettings(type) {
  return {
    headToHeadMatches: 1,
    extraTime: type === 'knockout',
    penalties: type === 'knockout',
    suspensionSystem: { enabled: true, yellowCardsForSuspension: 2, redCardMissedMatches: 1 },
    points: { win: 3, draw: 1, loss: 0 },
    teamsAdvancePerGroup: type === 'league' ? 2 : null,
  };
}

// Renders the settings fields for a stage under a unique DOM id namespace `ns`.
function stageSettingsFieldsHtml(ns, s, stageType) {
  return `
    <div class="grid cols-3">
      <div class="field"><label>Head-to-head matches</label>
        <input type="number" min="1" id="${ns}-h2h" value="${s.headToHeadMatches}"></div>
      <div class="field"><label>Teams advancing${stageType === 'knockout' ? ' (to next stage)' : ' / group'}</label>
        <input type="number" min="0" id="${ns}-adv" value="${s.teamsAdvancePerGroup ?? ''}" placeholder="all"></div>
      <div class="field"><label>&nbsp;</label>
        <div class="checkline"><input type="checkbox" id="${ns}-et" ${s.extraTime ? 'checked' : ''}> Extra time</div>
        <div class="checkline" style="margin-top:4px"><input type="checkbox" id="${ns}-pen" ${s.penalties ? 'checked' : ''}> Penalties</div>
      </div>
    </div>
    <div class="grid cols-3">
      <div class="field"><label>Points — win</label><input type="number" id="${ns}-pw" value="${s.points.win}"></div>
      <div class="field"><label>Points — draw</label><input type="number" id="${ns}-pd" value="${s.points.draw}"></div>
      <div class="field"><label>Points — loss</label><input type="number" id="${ns}-pl" value="${s.points.loss}"></div>
    </div>
    <div class="grid cols-3">
      <div class="field"><div class="checkline"><input type="checkbox" id="${ns}-se" ${s.suspensionSystem.enabled ? 'checked' : ''}> Suspension system</div></div>
      <div class="field"><label>Yellow cards → suspension</label><input type="number" id="${ns}-sy" value="${s.suspensionSystem.yellowCardsForSuspension}"></div>
      <div class="field"><label>Matches missed / red card</label><input type="number" id="${ns}-sr" value="${s.suspensionSystem.redCardMissedMatches}"></div>
    </div>`;
}

function readStageSettingsFromRoot(root, ns) {
  const val = (id) => UI.qs('#' + id, root);
  const num = (el) => (el.value === '' ? null : Number(el.value));
  return {
    headToHeadMatches: num(val(`${ns}-h2h`)) ?? 1,
    teamsAdvancePerGroup: num(val(`${ns}-adv`)),
    extraTime: val(`${ns}-et`).checked,
    penalties: val(`${ns}-pen`).checked,
    points: {
      win: num(val(`${ns}-pw`)) ?? 0,
      draw: num(val(`${ns}-pd`)) ?? 0,
      loss: num(val(`${ns}-pl`)) ?? 0,
    },
    suspensionSystem: {
      enabled: val(`${ns}-se`).checked,
      yellowCardsForSuspension: num(val(`${ns}-sy`)) ?? 2,
      redCardMissedMatches: num(val(`${ns}-sr`)) ?? 1,
    },
  };
}

/* ===================== NEW TOURNAMENT WIZARD ========================= */

function viewNewTournament(container) {
  let step = 1;
  const wizard = { info: {}, stages: [] };

  function captureStep1() {
    wizard.info = {
      name: UI.qs('#w-name', container).value.trim(),
      slug: UI.qs('#w-slug', container).value.trim(),
      place: UI.qs('#w-place', container).value.trim(),
      visibility: UI.qs('#w-visibility', container).value,
      format: UI.qs('#w-format', container).value,
      numberOfTeams: UI.qs('#w-numteams', container).value,
    };
  }

  function captureStep2() {
    wizard.stages.forEach((s, idx) => {
      const typeSel = UI.qs(`[data-stage-type="${idx}"]`, container);
      if (typeSel) s.type = typeSel.value;
      const ns = `w${idx}`;
      if (UI.qs(`#${ns}-h2h`, container)) s.settings = readStageSettingsFromRoot(container, ns);
      const groupsInput = UI.qs(`#${ns}-groups`, container);
      if (groupsInput) s.groupsText = groupsInput.value;
    });
  }

  function buildPayload() {
    return {
      name: wizard.info.name,
      slug: wizard.info.slug || undefined,
      place: wizard.info.place || undefined,
      visibility: wizard.info.visibility || 'public',
      format: wizard.info.format || 'stages',
      numberOfTeams: wizard.info.numberOfTeams ? Number(wizard.info.numberOfTeams) : undefined,
      stages: wizard.stages.map((s) => ({
        type: s.type,
        settings: s.settings,
        groups: (s.groupsText || '').split(',').map((x) => x.trim()).filter(Boolean).map((name) => ({ name })),
      })),
    };
  }

  function stepsNav() {
    const labels = ['General info', 'Format', 'Review & create'];
    return `<div class="wizard-steps">${labels
      .map((l, i) => `<div class="step ${i + 1 === step ? 'active' : i + 1 < step ? 'done' : ''}">${i + 1}. ${l}</div>`)
      .join('')}</div>`;
  }

  function renderStep2Stages() {
    const box = UI.qs('#step2-stages', container);
    box.innerHTML = wizard.stages.length
      ? wizard.stages.map((s, idx) => `
        <div class="stage-block">
          <div class="row between">
            <div class="row">
              <strong>Stage ${idx + 1}</strong>
              <select data-stage-type="${idx}">
                <option value="league" ${s.type === 'league' ? 'selected' : ''}>League (round robin)</option>
                <option value="knockout" ${s.type === 'knockout' ? 'selected' : ''}>Knockout</option>
              </select>
            </div>
            <button type="button" class="small ghost" data-remove-stage="${idx}">✕ Remove stage</button>
          </div>
          ${stageSettingsFieldsHtml(`w${idx}`, s.settings, s.type)}
          <div class="field"><label>Groups (comma-separated names, optional)</label>
            <input type="text" id="w${idx}-groups" value="${UI.esc(s.groupsText || '')}" placeholder="e.g. Group A, Group B"></div>
        </div>`).join('')
      : '<p class="empty">No stages yet — a tournament can also be created without one and formatted later.</p>';

    UI.qsa('[data-remove-stage]', box).forEach((b) => b.addEventListener('click', () => {
      captureStep2();
      wizard.stages.splice(Number(b.dataset.removeStage), 1);
      renderStep2Stages();
    }));
    UI.qsa('[data-stage-type]', box).forEach((sel) => sel.addEventListener('change', () => {
      captureStep2();
      const idx = Number(sel.dataset.stageType);
      wizard.stages[idx].type = sel.value;
      wizard.stages[idx].settings = defaultStageSettings(sel.value);
      renderStep2Stages();
    }));
  }

  function render() {
    if (step === 1) {
      container.innerHTML = stepsNav() + `
        <div class="card">
          <h2>General info</h2>
          <div class="grid cols-2">
            <div class="field"><label>Name *</label><input type="text" id="w-name" value="${UI.esc(wizard.info.name || '')}" required></div>
            <div class="field"><label>Slug</label><input type="text" id="w-slug" value="${UI.esc(wizard.info.slug || '')}" placeholder="auto-generated from name"></div>
            <div class="field"><label>Place</label><input type="text" id="w-place" value="${UI.esc(wizard.info.place || '')}"></div>
            <div class="field"><label>Visibility</label>
              <select id="w-visibility">
                <option value="public" ${wizard.info.visibility !== 'private' ? 'selected' : ''}>Public</option>
                <option value="private" ${wizard.info.visibility === 'private' ? 'selected' : ''}>Private</option>
              </select></div>
            <div class="field"><label>Format label</label>
              <select id="w-format">
                ${['stages', 'groups', 'division', 'league', 'knockout', 'custom']
                  .map((f) => `<option value="${f}" ${wizard.info.format === f ? 'selected' : ''}>${f}</option>`).join('')}
              </select></div>
            <div class="field"><label>Expected number of teams</label>
              <input type="number" min="0" id="w-numteams" value="${UI.esc(wizard.info.numberOfTeams || '')}"></div>
          </div>
        </div>
        <div class="row" style="justify-content:flex-end">
          <button class="primary" id="w-next1">Next: Format →</button>
        </div>`;
      UI.qs('#w-next1', container).addEventListener('click', () => {
        const name = UI.qs('#w-name', container).value.trim();
        if (!name) { UI.toast('Name is required'); return; }
        captureStep1();
        step = 2;
        render();
      });
      return;
    }

    if (step === 2) {
      container.innerHTML = stepsNav() + `
        <div class="card">
          <h2>Competition format</h2>
          <p class="muted">Add one or more stages. <strong>League</strong> = round-robin group play,
            <strong>knockout</strong> = single/double-leg elimination. These settings mirror the
            backend's default stage settings exactly.</p>
          <div id="step2-stages"></div>
          <button type="button" class="small" id="w-add-stage">+ Add stage</button>
        </div>
        <div class="row between">
          <button id="w-back1">← Back</button>
          <button class="primary" id="w-next2">Next: Review →</button>
        </div>`;
      renderStep2Stages();
      UI.qs('#w-add-stage', container).addEventListener('click', () => {
        captureStep2();
        wizard.stages.push({ type: 'league', settings: defaultStageSettings('league'), groupsText: '' });
        renderStep2Stages();
      });
      UI.qs('#w-back1', container).addEventListener('click', () => { captureStep2(); step = 1; render(); });
      UI.qs('#w-next2', container).addEventListener('click', () => { captureStep2(); step = 3; render(); });
      return;
    }

    // step 3 — review
    const payload = buildPayload();
    container.innerHTML = stepsNav() + `
      <div class="card">
        <h2>Review & create</h2>
        <p class="muted">This is exactly the JSON body that will be <code>POST</code>ed to <code>/tournaments</code>.</p>
        <textarea readonly style="min-height:280px">${UI.esc(JSON.stringify(payload, null, 2))}</textarea>
      </div>
      <div class="row between">
        <button id="w-back2">← Back</button>
        <button class="primary" id="w-create">✓ Create tournament</button>
      </div>`;
    UI.qs('#w-back2', container).addEventListener('click', () => { step = 2; render(); });
    const createBtn = UI.qs('#w-create', container);
    createBtn.addEventListener('click', UI.guard(createBtn, async () => {
      const res = await API.tournaments.create(buildPayload());
      UI.toast('Tournament created', 'success');
      go(`#/tournaments/${res.tournament.id}`);
      route();
    }));
  }

  render();
}

/* ========================= TOURNAMENT DETAIL ========================= */

async function viewTournamentDetail(container, id, tab) {
  tab = tab || 'overview';
  container.innerHTML = '<p class="empty">Loading tournament…</p>';
  let tournament, stages;
  try {
    const data = await API.tournaments.get(id);
    tournament = data.tournament;
    stages = data.stages;
  } catch (err) {
    container.innerHTML = `<div class="error-box">${UI.esc(UI.errorMessage(err))}</div>
      <button id="back-list">← Back to tournaments</button>`;
    UI.qs('#back-list', container)?.addEventListener('click', () => go('#/tournaments'));
    return;
  }

  const tabs = [
    ['overview', 'Overview'], ['format', 'Format'], ['teams', 'Teams & Players'],
    ['draw', 'Draw'], ['matches', 'Matches'],
  ];
  container.innerHTML = `
    <div class="row between">
      <h1>${UI.esc(tournament.name)}</h1>
      <button class="ghost small" id="back-list">← All tournaments</button>
    </div>
    <div class="tabs">${tabs.map(([k, l]) => `<div class="tab ${k === tab ? 'active' : ''}" data-tab="${k}">${l}</div>`).join('')}</div>
    <div id="tab-content"></div>`;
  UI.qs('#back-list', container).addEventListener('click', () => go('#/tournaments'));
  UI.qsa('.tab', container).forEach((el) => el.addEventListener('click', () => go(`#/tournaments/${id}/${el.dataset.tab}`)));

  const content = UI.qs('#tab-content', container);
  const refresh = () => viewTournamentDetail(container, id, tab);

  if (tab === 'overview') tabOverview(content, tournament, stages, id, refresh);
  else if (tab === 'format') tabFormat(content, tournament, stages, id, refresh);
  else if (tab === 'teams') tabTeams(content, tournament, stages, id, refresh);
  else if (tab === 'draw') tabDraw(content, tournament, stages, id, refresh);
  else if (tab === 'matches') tabMatches(content, tournament, stages, id, refresh);
}

/* --- Overview tab: edit / delete / follow / followers moderation --- */
function tabOverview(content, tournament, stages, id, refresh) {
  const isAdmin = API.hasRole('admin');
  content.innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <div class="row between"><h3>Details</h3>${UI.statusBadge(tournament.status)}</div>
        <p><span class="muted">Slug</span> — <code>${UI.esc(tournament.slug)}</code></p>
        <p><span class="muted">Place</span> — ${UI.esc(tournament.place || '—')}</p>
        <p><span class="muted">Visibility</span> — ${UI.esc(tournament.visibility)}</p>
        <p><span class="muted">Format label</span> — ${UI.esc(tournament.format)}</p>
        <p><span class="muted">Expected teams</span> — ${tournament.numberOfTeams || '—'}</p>
        <p><span class="muted">Created</span> — ${UI.fmtDate(tournament.createdAt)}</p>
        <div class="row" style="margin-top:10px">
          <button class="small" id="follow-btn">☆ Follow</button>
          <button class="small ghost" id="unfollow-btn">Unfollow</button>
          ${isAdmin ? '<button class="small" id="toggle-edit">✎ Edit</button>' : ''}
          ${isAdmin ? '<button class="small danger" id="delete-t">🗑 Delete</button>' : ''}
        </div>
        ${isAdmin ? `
        <form id="edit-form" class="stack" style="display:none;margin-top:12px">
          <div class="grid cols-2">
            <div class="field"><label>Name</label><input type="text" id="e-name" value="${UI.esc(tournament.name)}"></div>
            <div class="field"><label>Place</label><input type="text" id="e-place" value="${UI.esc(tournament.place || '')}"></div>
            <div class="field"><label>Status</label>
              <select id="e-status">${['draft', 'registration', 'draw_complete', 'in_progress', 'completed']
                .map((s) => `<option ${s === tournament.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
            <div class="field"><label>Visibility</label>
              <select id="e-visibility">
                <option value="public" ${tournament.visibility === 'public' ? 'selected' : ''}>public</option>
                <option value="private" ${tournament.visibility === 'private' ? 'selected' : ''}>private</option>
              </select></div>
            <div class="field"><label>Format label</label>
              <select id="e-format">${['stages', 'groups', 'division', 'league', 'knockout', 'custom']
                .map((f) => `<option ${f === tournament.format ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
            <div class="field"><label>Expected teams</label><input type="number" id="e-numteams" value="${tournament.numberOfTeams || ''}"></div>
          </div>
          <button class="primary" type="submit">Save changes</button>
        </form>` : ''}
      </div>
      <div class="card">
        <h3>Followers</h3>
        <div id="followers-box">${isAdmin ? '<p class="empty">Loading…</p>' : '<p class="muted">Follower list is admin-only. Use the Follow / Unfollow buttons to exercise those endpoints as this user.</p>'}</div>
      </div>
    </div>`;

  UI.qs('#follow-btn', content).addEventListener('click', UI.guard(UI.qs('#follow-btn', content), async () => {
    await API.tournaments.follow(id);
    UI.toast('Follow request sent', 'success');
    if (isAdmin) loadFollowers();
  }));
  UI.qs('#unfollow-btn', content).addEventListener('click', UI.guard(UI.qs('#unfollow-btn', content), async () => {
    await API.tournaments.unfollow(id);
    UI.toast('Unfollowed', 'success');
    if (isAdmin) loadFollowers();
  }));

  if (isAdmin) {
    const toggleBtn = UI.qs('#toggle-edit', content);
    const form = UI.qs('#edit-form', content);
    toggleBtn.addEventListener('click', () => { form.style.display = form.style.display === 'none' ? 'block' : 'none'; });
    form.addEventListener('submit', UI.guard(form.querySelector('button[type=submit]'), async (e) => {
      e.preventDefault();
      await API.tournaments.update(id, {
        name: UI.qs('#e-name', form).value,
        place: UI.qs('#e-place', form).value,
        status: UI.qs('#e-status', form).value,
        visibility: UI.qs('#e-visibility', form).value,
        format: UI.qs('#e-format', form).value,
        numberOfTeams: Number(UI.qs('#e-numteams', form).value) || 0,
      });
      UI.toast('Tournament updated', 'success');
      refresh();
    }));
    UI.qs('#delete-t', content).addEventListener('click', UI.guard(UI.qs('#delete-t', content), async () => {
      if (!confirm('Delete this tournament permanently? This cannot be undone.')) return;
      await API.tournaments.remove(id);
      UI.toast('Tournament deleted', 'success');
      go('#/tournaments');
      route();
    }));
    loadFollowers();
  }

  async function loadFollowers() {
    const box = UI.qs('#followers-box', content);
    if (!box) return;
    try {
      const { followers } = await API.tournaments.listFollowers(id);
      box.innerHTML = followers.length ? followers.map((f) => `
        <div class="row between" style="padding:6px 0;border-bottom:1px solid var(--border)">
          <div>${UI.esc(f.user.name)} <span class="muted">${UI.esc(f.user.email)}</span> ${UI.statusBadge(f.status)}</div>
          ${f.status === 'pending' ? `<div class="row"><button class="small success" data-accept="${f.userId}">Accept</button><button class="small danger" data-reject="${f.userId}">Reject</button></div>` : ''}
        </div>`).join('') : '<p class="empty">No followers yet</p>';
      UI.qsa('[data-accept]', box).forEach((b) => b.addEventListener('click', UI.guard(b, async () => {
        await API.tournaments.moderateFollow(id, b.dataset.accept, 'accepted');
        UI.toast('Follower accepted', 'success'); loadFollowers();
      })));
      UI.qsa('[data-reject]', box).forEach((b) => b.addEventListener('click', UI.guard(b, async () => {
        await API.tournaments.moderateFollow(id, b.dataset.reject, 'rejected');
        UI.toast('Follower rejected', 'success'); loadFollowers();
      })));
    } catch (err) {
      box.innerHTML = `<div class="error-box">${UI.esc(UI.errorMessage(err))}</div>`;
    }
  }
}

/* --- Format tab: stages & groups CRUD --- */
function stageCardHtml(s, stages) {
  const prev = stages.find((x) => x.sequenceOrder === s.sequenceOrder - 1);
  const next = stages.find((x) => x.sequenceOrder === s.sequenceOrder + 1);
  const linkNote = prev
    ? `<p class="hint">🔗 Fed by stage #${prev.sequenceOrder} (${UI.esc(prev.type)}) — its draw pool is only the teams that stage promotes
        (top <strong>${prev.settings.teamsAdvancePerGroup ?? 'all'}</strong> ${prev.type === 'league' ? 'per group' : 'winner(s)'}).</p>`
    : '';
  const feedsNote = next
    ? `<p class="hint">➡ Feeds stage #${next.sequenceOrder} (${UI.esc(next.type)}) once every match here is finished.</p>`
    : '';
  const knockoutNote = s.type === 'knockout'
    ? '<p class="hint">🏆 Knockout rounds are generated automatically — the next round is drawn as soon as every match in the current round is finished.</p>'
    : '';
  return `
    <div class="stage-block" data-stage="${s.id}">
      <div class="row between">
        <div><strong>${UI.esc(s.type)}</strong> <span class="muted">stage #${s.sequenceOrder}</span></div>
        <div class="row">
          <button type="button" class="small" data-edit-stage>Save changes</button>
          <button type="button" class="small danger" data-del-stage>Delete stage</button>
        </div>
      </div>
      ${linkNote}${feedsNote}${knockoutNote}
      ${stageSettingsFieldsHtml('st-' + s.id, s.settings, s.type)}
      <h4>Groups</h4>
      <div>${s.groups.map((g) => `<span class="group-pill">${UI.esc(g.name)} <button type="button" class="small ghost icon" data-del-group="${g.id}">✕</button></span>`).join('') || '<span class="muted">No groups</span>'}</div>
      <form class="row" style="margin-top:8px" data-add-group-form>
        <input type="text" placeholder="New group name" id="newgroup-${s.id}" style="flex:1">
        <button class="small" type="submit">+ Group</button>
      </form>
    </div>`;
}

async function tabFormat(content, tournament, stages, id, refresh) {
  content.innerHTML = `
    <div id="stages-list">${stages.length ? stages.map((s) => stageCardHtml(s, stages)).join('') : '<p class="empty">No stages yet — add one below.</p>'}</div>
    <div class="card">
      <h3>Add a stage</h3>
      <p class="hint">Stages are chained by order: stage #2 draws only from the teams stage #1 promotes
        (set "Teams advancing" on stage #1 to control how many), and so on down the chain.</p>
      <div class="row" style="margin-bottom:10px">
        <label style="width:auto;margin:0">Type</label>
        <select id="fmt-add-type"><option value="league">League</option><option value="knockout">Knockout</option></select>
      </div>
      <div id="fmt-add-settings"></div>
      <div class="field"><label>Initial groups (comma-separated, optional)</label><input type="text" id="fmt-add-groups" placeholder="Group A, Group B"></div>
      <button class="primary" id="fmt-add-btn">+ Add stage</button>
    </div>`;

  function renderAddSettings() {
    const type = UI.qs('#fmt-add-type', content).value;
    UI.qs('#fmt-add-settings', content).innerHTML =
      stageSettingsFieldsHtml('fmt-add', defaultStageSettings(type), type);
  }
  renderAddSettings();
  UI.qs('#fmt-add-type', content).addEventListener('change', renderAddSettings);

  const addBtn = UI.qs('#fmt-add-btn', content);
  addBtn.addEventListener('click', UI.guard(addBtn, async () => {
    const type = UI.qs('#fmt-add-type', content).value;
    const settings = readStageSettingsFromRoot(content, 'fmt-add');
    const groups = UI.qs('#fmt-add-groups', content).value.split(',').map((s) => s.trim()).filter(Boolean).map((name) => ({ name }));
    await API.tournaments.addStage(id, { type, settings, groups });
    UI.toast('Stage added', 'success');
    refresh();
  }));

  for (const s of stages) {
    const block = UI.qs(`[data-stage="${s.id}"]`, content);
    if (!block) continue;
    const editBtn = block.querySelector('[data-edit-stage]');
    editBtn.addEventListener('click', UI.guard(editBtn, async () => {
      const settings = readStageSettingsFromRoot(block, 'st-' + s.id);
      await API.tournaments.updateStage(s.id, { settings });
      UI.toast('Stage updated', 'success'); refresh();
    }));
    const delBtn = block.querySelector('[data-del-stage]');
    delBtn.addEventListener('click', UI.guard(delBtn, async () => {
      if (!confirm('Delete this stage and its groups?')) return;
      await API.tournaments.removeStage(s.id);
      UI.toast('Stage deleted', 'success'); refresh();
    }));
    UI.qsa('[data-del-group]', block).forEach((btn) => btn.addEventListener('click', UI.guard(btn, async () => {
      if (!confirm('Delete this group?')) return;
      await API.tournaments.removeGroup(btn.dataset.delGroup);
      UI.toast('Group deleted', 'success'); refresh();
    })));
    const groupForm = block.querySelector('[data-add-group-form]');
    groupForm.addEventListener('submit', UI.guard(groupForm.querySelector('button'), async (e) => {
      e.preventDefault();
      const input = UI.qs(`#newgroup-${s.id}`, block);
      if (!input.value.trim()) return;
      await API.tournaments.addGroup(s.id, { name: input.value.trim() });
      UI.toast('Group added', 'success'); refresh();
    }));
  }
}

/* --- Teams & Players tab: catalog + participants + roster + auto-fill --- */
function ptCardHtml(pt, allGroups) {
  return `
    <div class="pt-card" data-pt="${pt.id}">
      <div class="pt-header" data-toggle>
        <div><strong>${UI.esc(pt.team?.name || 'Unknown team')}</strong> ${pt.seed ? `<span class="muted">seed ${pt.seed}</span>` : ''} ${UI.statusBadge(pt.status)}</div>
        <div class="row">
          <span class="muted">P${pt.stats.played} W${pt.stats.won} D${pt.stats.drawn} L${pt.stats.lost} Pts${pt.stats.points}</span>
          <button type="button" class="small ghost icon" data-remove-pt>✕</button>
        </div>
      </div>
      <div class="pt-body" id="pt-body-${pt.id}">
        <div class="row">
          <div class="field" style="flex:1"><label>Seed</label><input type="number" id="pt-seed-${pt.id}" value="${pt.seed ?? ''}"></div>
          <div class="field" style="flex:1"><label>Nickname</label><input type="text" id="pt-nick-${pt.id}" value="${UI.esc(pt.nickname || '')}"></div>
          <div class="field" style="flex:2"><label>Group</label>
            <select id="pt-group-${pt.id}">
              <option value="">— none —</option>
              ${allGroups.map((g) => `<option value="${g.id}" ${g.id === pt.groupId ? 'selected' : ''}>${UI.esc(g.name)} (${g.stageType})</option>`).join('')}
            </select></div>
          <div style="align-self:flex-end;margin-bottom:10px"><button type="button" class="small" data-save-pt>Save</button></div>
        </div>
        <h4>Roster</h4>
        <div id="roster-${pt.id}" class="muted">Not loaded yet — expand to load.</div>
        <form class="row" data-add-player-form style="margin-top:6px">
          <select id="player-select-${pt.id}" style="flex:1"><option value="">Loading players…</option></select>
          <input type="number" id="shirt-${pt.id}" placeholder="#" style="width:60px">
          <button class="small" type="submit">+ Add to roster</button>
        </form>
      </div>
    </div>`;
}

async function tabTeams(content, tournament, stages, id, refresh) {
  content.innerHTML = '<p class="empty">Loading teams & players…</p>';
  let teamsCat, playersCat, ptRes;
  try {
    [teamsCat, playersCat, ptRes] = await Promise.all([
      API.teams.list(), API.players.list(), API.participants.listTeams(id),
    ]);
  } catch (err) {
    content.innerHTML = `<div class="error-box">${UI.esc(UI.errorMessage(err))}</div>`;
    return;
  }
  const allGroups = stages.flatMap((s) => s.groups.map((g) => ({ ...g, stageType: s.type })));
  const isAdmin = API.hasRole('admin');

  content.innerHTML = `
    <div class="grid cols-2">
      <div>
        ${isAdmin ? `
        <div class="card">
          <div class="row between"><h3>Catalog — Teams</h3><span class="muted">${teamsCat.teams.length}</span></div>
          <form id="quick-team-form" class="row">
            <input type="text" id="qt-name" placeholder="New team name" required style="flex:1">
            <button class="small" type="submit">+ Team</button>
          </form>
          <div style="max-height:200px;overflow:auto;margin-top:8px">
            ${teamsCat.teams.map((t) => `<div class="row between" style="padding:4px 0"><span>${UI.esc(t.name)}</span><button type="button" class="small ghost icon" data-del-team="${t.id}">✕</button></div>`).join('') || '<p class="empty">No teams yet</p>'}
          </div>
        </div>
        <div class="card">
          <div class="row between"><h3>Catalog — Players</h3><span class="muted">${playersCat.players.length}</span></div>
          <form id="quick-player-form" class="row">
            <input type="text" id="qp-name" placeholder="New player name" required style="flex:1">
            <button class="small" type="submit">+ Player</button>
          </form>
          <div style="max-height:200px;overflow:auto;margin-top:8px">
            ${playersCat.players.map((p) => `<div class="row between" style="padding:4px 0"><span>${UI.esc(p.name)}</span><button type="button" class="small ghost icon" data-del-player="${p.id}">✕</button></div>`).join('') || '<p class="empty">No players yet</p>'}
          </div>
        </div>` : `<div class="card"><p class="muted">Team/player catalog management is admin-only. You can still view registered teams on the right.</p></div>`}
      </div>
      <div>
        <div class="card">
          <div class="row between">
            <h3>Registered teams (${ptRes.participantTeams.length}${tournament.numberOfTeams ? ` / ${tournament.numberOfTeams}` : ''})</h3>
            ${isAdmin ? '<button type="button" class="small" id="autofill-btn">⚡ Auto-fill teams & players</button>' : ''}
          </div>
          ${isAdmin ? `
          <form id="add-pt-form" class="row">
            <select id="pt-team-select" style="flex:1" required>
              <option value="">Select team from catalog…</option>
              ${teamsCat.teams.map((t) => `<option value="${t.id}">${UI.esc(t.name)}</option>`).join('')}
            </select>
            <input type="number" id="pt-seed" placeholder="Seed" style="width:80px">
            <button class="small" type="submit">+ Register</button>
          </form>
          <p class="hint" style="margin-top:8px">Skipping this step is fine — use <strong>Auto-fill</strong> to create default teams and 11 default players each, which you can rename/edit anytime.</p>
          ` : ''}
          <div id="pt-list" style="margin-top:10px">
            ${ptRes.participantTeams.map((pt) => ptCardHtml(pt, allGroups)).join('') || '<p class="empty">No teams registered yet.</p>'}
          </div>
        </div>
      </div>
    </div>`;

  if (isAdmin) {
    const qtForm = UI.qs('#quick-team-form', content);
    qtForm.addEventListener('submit', UI.guard(qtForm.querySelector('button'), async (e) => {
      e.preventDefault();
      await API.teams.create({ name: UI.qs('#qt-name', qtForm).value.trim() });
      UI.toast('Team created', 'success'); refresh();
    }));
    const qpForm = UI.qs('#quick-player-form', content);
    qpForm.addEventListener('submit', UI.guard(qpForm.querySelector('button'), async (e) => {
      e.preventDefault();
      await API.players.create({ name: UI.qs('#qp-name', qpForm).value.trim() });
      UI.toast('Player created', 'success'); refresh();
    }));
    UI.qsa('[data-del-team]', content).forEach((b) => b.addEventListener('click', UI.guard(b, async () => {
      if (!confirm('Delete this team from the catalog?')) return;
      await API.teams.remove(b.dataset.delTeam);
      UI.toast('Team deleted', 'success'); refresh();
    })));
    UI.qsa('[data-del-player]', content).forEach((b) => b.addEventListener('click', UI.guard(b, async () => {
      if (!confirm('Delete this player from the catalog?')) return;
      await API.players.remove(b.dataset.delPlayer);
      UI.toast('Player deleted', 'success'); refresh();
    })));

    const addPtForm = UI.qs('#add-pt-form', content);
    addPtForm.addEventListener('submit', UI.guard(addPtForm.querySelector('button'), async (e) => {
      e.preventDefault();
      const teamId = UI.qs('#pt-team-select', addPtForm).value;
      if (!teamId) return;
      const seed = UI.qs('#pt-seed', addPtForm).value;
      await API.participants.addTeam(id, { teamId, seed: seed ? Number(seed) : undefined });
      UI.toast('Team registered', 'success'); refresh();
    }));

    const autofillBtn = UI.qs('#autofill-btn', content);
    autofillBtn.addEventListener('click', UI.guard(autofillBtn, async () => {
      let count = tournament.numberOfTeams > 0 ? tournament.numberOfTeams : Number(prompt('How many teams to generate?', '8'));
      if (!count) return;
      for (let i = 1; i <= count; i += 1) {
        autofillBtn.textContent = `Generating team ${i}/${count}…`;
        const team = await API.teams.create({ name: `Team ${i}`, shortName: `T${i}` });
        const pt = await API.participants.addTeam(id, { teamId: team.team.id, seed: i });
        for (let p = 1; p <= 11; p += 1) {
          const player = await API.players.create({
            name: `Team ${i} Player ${p}`,
            position: p === 1 ? 'goalkeeper' : 'player',
          });
          await API.participants.addPlayer(pt.participantTeam.id, { playerId: player.player.id, shirtNumber: p });
        }
      }
      UI.toast('Auto-fill complete — edit names anytime', 'success');
      refresh();
    }));
  }

  // participant team cards: toggle roster, save/remove, add player to roster
  for (const pt of ptRes.participantTeams) {
    const card = UI.qs(`[data-pt="${pt.id}"]`, content);
    if (!card) continue;
    const body = UI.qs(`#pt-body-${pt.id}`, card);
    let rosterLoaded = false;

    card.querySelector('[data-toggle]').addEventListener('click', async () => {
      body.classList.toggle('open');
      if (body.classList.contains('open') && !rosterLoaded) {
        rosterLoaded = true;
        const rosterBox = UI.qs(`#roster-${pt.id}`, body);
        const playerSelect = UI.qs(`#player-select-${pt.id}`, body);
        playerSelect.innerHTML = playersCat.players.length
          ? playersCat.players.map((p) => `<option value="${p.id}">${UI.esc(p.name)}</option>`).join('')
          : '<option value="">No players in catalog</option>';
        try {
          const { participantPlayers } = await API.participants.listPlayers(pt.id);
          rosterBox.innerHTML = participantPlayers.length ? `
            <table><thead><tr><th>#</th><th>Name</th><th>Role</th><th></th></tr></thead>
            <tbody>${participantPlayers.map((pp) => `
              <tr data-pp="${pp.id}">
                <td>${pp.shirtNumber ?? '—'}</td>
                <td>${UI.esc(pp.player?.name || '—')}</td>
                <td>${UI.esc(pp.role)}</td>
                <td><button type="button" class="small ghost icon" data-remove-pp="${pp.id}">✕</button></td>
              </tr>`).join('')}</tbody></table>` : '<p class="empty">No players on this roster yet.</p>';
          UI.qsa('[data-remove-pp]', rosterBox).forEach((b) => b.addEventListener('click', UI.guard(b, async () => {
            await API.participants.removePlayer(b.dataset.removePp);
            UI.toast('Player removed from roster', 'success'); refresh();
          })));
        } catch (err) {
          rosterBox.innerHTML = `<div class="error-box">${UI.esc(UI.errorMessage(err))}</div>`;
        }
      }
    });

    if (isAdmin) {
      card.querySelector('[data-save-pt]').addEventListener('click', UI.guard(card.querySelector('[data-save-pt]'), async () => {
        await API.participants.updateTeam(pt.id, {
          seed: Number(UI.qs(`#pt-seed-${pt.id}`, card).value) || null,
          nickname: UI.qs(`#pt-nick-${pt.id}`, card).value || null,
          groupId: UI.qs(`#pt-group-${pt.id}`, card).value || null,
        });
        UI.toast('Team updated', 'success'); refresh();
      }));
      card.querySelector('[data-remove-pt]').addEventListener('click', UI.guard(card.querySelector('[data-remove-pt]'), async () => {
        if (!confirm('Remove this team from the tournament?')) return;
        await API.participants.removeTeam(pt.id);
        UI.toast('Team removed', 'success'); refresh();
      }));
      const addPlayerForm = card.querySelector('[data-add-player-form]');
      addPlayerForm.addEventListener('submit', UI.guard(addPlayerForm.querySelector('button'), async (e) => {
        e.preventDefault();
        const playerId = UI.qs(`#player-select-${pt.id}`, card).value;
        if (!playerId) return;
        const shirt = UI.qs(`#shirt-${pt.id}`, card).value;
        await API.participants.addPlayer(pt.id, { playerId, shirtNumber: shirt ? Number(shirt) : undefined });
        UI.toast('Player added to roster', 'success'); refresh();
      }));
    }
  }
}

/* --- Draw tab --- */
async function tabDraw(content, tournament, stages, id, refresh) {
  const sorted = [...stages].sort((a, b) => a.sequenceOrder - b.sequenceOrder);
  function stageOptionLabel(s) {
    const prev = sorted.find((x) => x.sequenceOrder === s.sequenceOrder - 1);
    return prev
      ? `${UI.esc(s.type)} — stage #${s.sequenceOrder} (uses teams promoted from stage #${prev.sequenceOrder})`
      : `${UI.esc(s.type)} — stage #${s.sequenceOrder} (all registered teams)`;
  }
  content.innerHTML = `
    <div class="card">
      <h3>Run the draw</h3>
      <p class="muted">Draws the selected stage and generates its matches
        (round-robin fixtures for a league stage, a first-round bracket for a knockout stage).
        Stage #1 draws from every registered team; any later stage draws only from the teams the
        stage before it promotes, and requires that earlier stage to be fully finished first.
        Knockout stages generate each following round automatically as the current round's matches
        are finished — you only need to run the draw once, for the first round.</p>
      ${stages.length ? `
      <form id="draw-form" class="row">
        <select id="draw-stage">
          ${sorted.map((s) => `<option value="${s.id}">${stageOptionLabel(s)}</option>`).join('')}
        </select>
        <button class="primary" type="submit">🎲 Run draw</button>
      </form>` : '<p class="empty">Add a stage in the Format tab first.</p>'}
    </div>
    <div id="draw-result"></div>`;

  const form = UI.qs('#draw-form', content);
  if (form) {
    form.addEventListener('submit', UI.guard(form.querySelector('button'), async (e) => {
      e.preventDefault();
      const stageId = UI.qs('#draw-stage', form).value;
      const res = await API.matches.draw(id, stageId);
      UI.qs('#draw-result', content).innerHTML = `
        <div class="card">
          <h4>Draw result</h4>
          <p>Stage #${res.draw.sequenceOrder} (<strong>${UI.esc(res.draw.stageType)}</strong>) —
             ${res.draw.assigned} teams assigned, ${res.draw.matchesCreated} matches created
             ${res.draw.firstRound ? ` (first round: ${UI.esc(res.draw.firstRound)})` : ''}
             ${res.draw.promotedFromStage ? ` — drawn from teams promoted out of stage #${res.draw.promotedFromStage}` : ''}</p>
        </div>`;
      UI.toast('Draw complete — see Matches tab', 'success');
    }));
  }
}

/* --- Matches tab --- */
function matchRowHtml(m, teamName, canOfficiate) {
  return `
    <div class="match-row" data-match="${m.id}">
      <div class="row between">
        <div class="match-teams">
          ${UI.esc(teamName(m.homeParticipantTeamId))}
          <input class="score-input" type="number" min="0" id="hs-${m.id}" value="${m.score.home ?? ''}">
          <span class="vs">vs</span>
          <input class="score-input" type="number" min="0" id="as-${m.id}" value="${m.score.away ?? ''}">
          ${UI.esc(teamName(m.awayParticipantTeamId))}
        </div>
        <div class="row">${UI.statusBadge(m.status)}<span class="muted">MD ${m.matchday}</span></div>
      </div>
      <div class="row between" style="margin-top:8px">
        <div class="row">
          <input type="text" id="venue-${m.id}" placeholder="Venue" value="${UI.esc(m.venue || '')}" style="width:150px">
          <span class="muted">Referee: ${m.refereeId ? m.refereeId.slice(0, 8) + '…' : 'none yet'}</span>
        </div>
        <div class="row">
          <button type="button" class="small" data-save-score="${m.id}">Save score/venue</button>
          ${m.status === 'scheduled'
            ? (canOfficiate ? `<button type="button" class="small success" data-start="${m.id}">▶ Start (attaches you as referee)</button>` : '<span class="muted">Only admin/referee can start</span>')
            : ''}
          ${m.status !== 'finished' && canOfficiate ? `<button type="button" class="small primary" data-finish="${m.id}">🏁 Finish</button>` : ''}
        </div>
      </div>
    </div>`;
}

// Buckets every match under the stage → group it belongs to, so callers can
// render "Group A together", "Semi-finals together", etc. instead of one
// flat list. Groups are sorted by sequenceOrder; a stage with no explicit
// groups falls back to a single synthetic "Matches" bucket.
function groupMatchesByStage(matches, stages) {
  return stages.map((stage) => {
    const rawGroups = stage.groups && stage.groups.length ? stage.groups : [{ id: null, name: 'Matches', sequenceOrder: 1 }];
    const groups = [...rawGroups]
      .sort((a, b) => a.sequenceOrder - b.sequenceOrder)
      .map((g) => ({
        ...g,
        matches: matches.filter((m) => m.stageId === stage.id && (g.id ? m.groupId === g.id : !m.groupId)),
      }));
    return { stage, groups };
  });
}

function matchdaySections(matches) {
  const byMatchday = new Map();
  for (const m of matches) {
    const key = m.matchday ?? 0;
    if (!byMatchday.has(key)) byMatchday.set(key, []);
    byMatchday.get(key).push(m);
  }
  return [...byMatchday.entries()].sort((a, b) => a[0] - b[0]);
}

// One card per league group — its matches (from every registered team,
// tied to that specific group) organized into matchday sub-sections.
function leagueGroupCardHtml(group, teamName, canOfficiate) {
  const mds = matchdaySections(group.matches);
  return `
    <div class="card">
      <h3>${UI.esc(group.name)}</h3>
      ${group.matches.length
        ? mds.map(([md, ms]) => `
          <div class="matchday-block">
            <h4>Matchday ${md}</h4>
            <div class="stack">${ms.map((m) => matchRowHtml(m, teamName, canOfficiate)).join('')}</div>
          </div>`).join('')
        : '<p class="empty">No matches yet</p>'}
    </div>`;
}

// One bracket column per knockout round. Matches that share a matchday are
// the same tie (i.e. both legs of a 2-legged semi-final) and are kept
// visually together under one "Tie" label. Rounds with no matches yet still
// render as an empty column so the shape of the whole bracket is visible.
function bracketRoundHtml(group, teamName, canOfficiate) {
  const ties = matchdaySections(group.matches);
  return `
    <div class="bracket-round">
      <div class="bracket-round-header">${UI.esc(group.name)}</div>
      ${group.matches.length
        ? ties.map(([tieNo, ms]) => `
          <div class="bracket-match${ms.length > 1 ? ' multi-leg' : ''}">
            ${ms.length > 1 ? `<div class="tie-label">Tie ${tieNo} · ${ms.length} legs</div>` : ''}
            <div class="stack">${ms.map((m) => matchRowHtml(m, teamName, canOfficiate)).join('')}</div>
          </div>`).join('')
        : '<div class="bracket-match empty-slot"><p class="empty">Not drawn yet</p></div>'}
    </div>`;
}

async function tabMatches(content, tournament, stages, id, refresh) {
  content.innerHTML = '<p class="empty">Loading matches…</p>';
  let mRes, ptRes;
  try {
    [mRes, ptRes] = await Promise.all([API.matches.list(id), API.participants.listTeams(id)]);
  } catch (err) {
    content.innerHTML = `<div class="error-box">${UI.esc(UI.errorMessage(err))}</div>`;
    return;
  }
  const teamName = (ptId) => {
    const pt = ptRes.participantTeams.find((p) => p.id === ptId);
    return pt ? pt.team?.name || 'Unknown' : '—';
  };
  const me = API.getUser();
  const canOfficiate = me && ['admin', 'referee'].includes(me.role);

  const sortedStages = [...stages].sort((a, b) => a.sequenceOrder - b.sequenceOrder);
  const byStage = groupMatchesByStage(mRes.matches, sortedStages);
  const anyMatches = mRes.matches.length > 0;

  content.innerHTML = `
    <p class="hint">The backend attaches a referee to a match by recording <em>who started it</em> —
      there's no separate "assign referee to someone else" endpoint. Log in as a referee (or admin)
      and use <strong>Start</strong> to attach yourself.</p>
    ${anyMatches
      ? byStage.filter(({ groups }) => groups.some((g) => g.matches.length)).map(({ stage, groups }) => `
        <div class="stage-matches">
          <h2>Stage #${stage.sequenceOrder} <span class="muted" style="font-weight:400;font-size:14px">— ${UI.esc(stage.type)}</span></h2>
          ${stage.type === 'knockout'
            ? `<div class="bracket">${groups.map((g) => bracketRoundHtml(g, teamName, canOfficiate)).join('')}</div>`
            : `<div class="grid cols-2">${groups.map((g) => leagueGroupCardHtml(g, teamName, canOfficiate)).join('')}</div>`}
        </div>`).join('')
      : '<p class="empty">No matches yet — run the draw first.</p>'}`;

  UI.qsa('[data-save-score]', content).forEach((btn) => btn.addEventListener('click', UI.guard(btn, async () => {
    const mid = btn.dataset.saveScore;
    const hs = UI.qs(`#hs-${mid}`, content).value;
    const as = UI.qs(`#as-${mid}`, content).value;
    const venue = UI.qs(`#venue-${mid}`, content).value;
    await API.matches.update(mid, {
      homeScore: hs === '' ? null : Number(hs),
      awayScore: as === '' ? null : Number(as),
      venue: venue || null,
    });
    UI.toast('Match updated', 'success'); refresh();
  })));

  UI.qsa('[data-start]', content).forEach((btn) => btn.addEventListener('click', UI.guard(btn, async () => {
    const mid = btn.dataset.start;
    const venue = UI.qs(`#venue-${mid}`, content).value;
    await API.matches.start(mid, venue || undefined);
    UI.toast('Match started — you are now the referee', 'success'); refresh();
  })));

  UI.qsa('[data-finish]', content).forEach((btn) => btn.addEventListener('click', UI.guard(btn, async () => {
    const mid = btn.dataset.finish;
    const hs = UI.qs(`#hs-${mid}`, content).value;
    const as = UI.qs(`#as-${mid}`, content).value;
    if (hs === '' || as === '') { UI.toast('Enter both scores before finishing'); return; }
    const res = await API.matches.finish(mid, { homeScore: Number(hs), awayScore: Number(as) });
    UI.toast('Match finished', 'success');
    if (res.advance?.finalized) {
      UI.toast(`🏆 ${res.advance.round} complete — champion crowned!`, 'success');
    } else if (res.advance?.round) {
      UI.toast(`Round complete — ${res.advance.round} drawn automatically (${res.advance.matchesCreated} matches)`, 'success');
    } else if (res.advance?.pending) {
      UI.toast(`${res.advance.round}: ${res.advance.reason}`);
    }
    refresh();
  })));
}

/* =========================== ADMIN USERS ============================= */

async function viewAdminUsers(container) {
  if (!API.hasRole('admin')) {
    container.innerHTML = '<div class="error-box">Admins only.</div>';
    return;
  }
  container.innerHTML = '<p class="empty">Loading users…</p>';
  let users;
  try {
    ({ users } = await API.auth.listUsers());
  } catch (err) {
    container.innerHTML = `<div class="error-box">${UI.esc(UI.errorMessage(err))}</div>`;
    return;
  }
  container.innerHTML = `
    <h1>Users</h1>
    <div class="card">
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Joined</th><th>Change role</th></tr></thead>
        <tbody>${users.map((u) => `
          <tr data-user="${u.id}">
            <td>${UI.esc(u.name)}</td>
            <td>${UI.esc(u.email)}</td>
            <td>${UI.roleBadge(u.role)}</td>
            <td class="muted">${UI.fmtDate(u.createdAt)}</td>
            <td>
              <select data-role-select="${u.id}">
                ${['user', 'referee', 'admin'].map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}
              </select>
            </td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;
  UI.qsa('[data-role-select]', container).forEach((sel) => sel.addEventListener('change', UI.guard(sel, async () => {
    await API.auth.updateRole(sel.dataset.roleSelect, sel.value);
    UI.toast('Role updated', 'success');
  })));
}

/* =============================== EXPORT =============================== */

const VIEWS = {
  login: viewLogin,
  register: viewRegister,
  tournamentList: viewTournamentList,
  newTournament: viewNewTournament,
  tournamentDetail: viewTournamentDetail,
  adminUsers: viewAdminUsers,
};
