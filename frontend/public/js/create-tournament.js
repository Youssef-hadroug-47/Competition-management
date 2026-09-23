(function () {
  const { el, clear, showBanner, friendlyErrorMessage } = UI;
  if (!Session.isAuthenticated()) { location.href = '/login.html?next=%2Fcreate-tournament.html'; return; }
  Header.render(document.getElementById('topbar-actions'));
  const form = document.getElementById('create-wizard-form');
  const general = document.getElementById('phase-general');
  const format = document.getElementById('phase-format');
  const banner = document.getElementById('banner');
  const next = document.getElementById('wizard-next');
  const back = document.getElementById('wizard-back');
  const steps = document.getElementById('wizard-steps');
  const navigationState = UI.pageState('create-tournament');
  let phase = 1;
  let activeStageIndex = 0;
  const stages = [];
  navigationState.restoreScroll();

  const input = (label, name, type = 'text', attrs = {}) => el('div', { class: 'field' }, [
    el('label', { for: `create-${name}`, text: label }),
    el('input', { id: `create-${name}`, name, type, ...attrs }),
  ]);
  const select = (label, name, options) => el('div', { class: 'field' }, [
    el('label', { for: `create-${name}`, text: label }),
    el('select', { id: `create-${name}`, name }, options.map(([value, text]) => el('option', { value, text }))),
  ]);
  function renderSteps() {
    clear(steps);
    ['General info', 'Competition format'].forEach((label, i) => steps.appendChild(el('span', { class: `wizard-step${phase === i + 1 ? ' wizard-step--active' : ''}`, text: `${i + 1}. ${label}` })));
  }
  function renderGeneral() {
    clear(general);
    general.appendChild(el('h2', { text: 'General information' }));
    general.appendChild(el('p', { text: 'Give your tournament a clear identity and set who can see it.' }));
    general.appendChild(input('Name', 'tournamentName', 'text', { required: 'required', maxlength: '120', autocomplete: 'off' }));
    general.appendChild(input('Slug (optional)', 'tournamentSlug', 'text', { maxlength: '120', pattern: '[a-z0-9-]*', placeholder: 'auto-generated-from-name' }));
    general.appendChild(input('Place (optional)', 'tournamentPlace', 'text', { maxlength: '120' }));
    general.appendChild(el('div', { class: 'form-grid' }, [
      select('Visibility', 'tournamentVisibility', [['public', 'Public'], ['private', 'Private']]),
      input('Number of teams', 'tournamentNumberOfTeams', 'number', { required: 'required', min: '3', max: '256' }),
    ]));
  }
  function targetOptions(current) {
    return [['', 'Choose a target stage'], ...stages
      .map((s, i) => [String(i), `${i + 1}. ${s.name || 'Untitled stage'}`])
      .filter((entry) => Number(entry[0]) !== current)];
  }
  const tiebreakerOptions = [
    ['points', 'Points'],
    ['head_to_head', 'Head-to-head'],
    ['goal_difference', 'Goal difference'],
    ['goals_for', 'Goals for'],
    ['sportsmanlike', 'Sportsmanlike'],
  ];
  const defaultTiebreakers = () => tiebreakerOptions.map(([type], priority) => ({ type, priority: priority + 1 }));

  function renderTiebreakerRow(rule = {}) {
    const row = el('div', { class: 'tiebreaker-row' });
    const criterion = el('select', { name: 'tiebreakerType', required: 'required' },
      tiebreakerOptions.map(([value, text]) => el('option', { value, text })));
    criterion.value = rule.type || 'points';
    const priority = el('input', {
      type: 'number',
      name: 'tiebreakerPriority',
      min: 1,
      max: 20,
      required: 'required',
      value: String(rule.priority || 1),
      'aria-label': 'Tiebreaker priority',
    });
    row.append(
      el('label', { class: 'tiebreaker-row__criterion' }, [
        el('span', { text: 'Criterion' }),
        criterion,
      ]),
      el('label', { class: 'tiebreaker-row__priority' }, [
        el('span', { text: 'Priority' }),
        priority,
      ]),
      el('button', { class: 'btn btn--ghost tiebreaker-remove', type: 'button', text: 'Remove' })
    );
    row.querySelector('.tiebreaker-remove').addEventListener('click', () => row.remove());
    return row;
  }

  function renderTiebreakers(stageSettings) {
    const rules = stageSettings.tiebreakers?.length ? stageSettings.tiebreakers : defaultTiebreakers();
    const list = el('div', { class: 'tiebreaker-list' }, rules.map((rule) => renderTiebreakerRow(rule)));
    const settings = el('div', { class: 'tiebreaker-settings' }, [
      el('h4', { text: 'Group tiebreakers' }),
      el('p', { class: 'field__hint', text: 'Choose the ranking criterion and its priority for every group in this league stage.' }),
      list,
      el('button', { class: 'btn btn--ghost tiebreaker-add', type: 'button', text: '+ Add tiebreaker' }),
    ]);
    settings.querySelector('.tiebreaker-add').addEventListener('click', () => list.appendChild(renderTiebreakerRow({
      type: 'points',
      priority: list.children.length + 1,
    })));
    return settings;
  }
  function renderRule(stageIndex, rule = {}) {
    const row = el('div', { class: 'rule-row' });
    row.dataset.rule = 'direct';
    row.appendChild(input('From rank', 'from', 'number', { min: 1, value: rule.from || 1 }));
    row.appendChild(input('To rank', 'to', 'number', { min: 1, value: rule.to || 1 }));
    const target = select('Target stage', 'target', targetOptions(stageIndex));
    const nextStage = stages.findIndex((stage, index) => index > stageIndex);
    target.querySelector('select').value = rule.target == null && nextStage >= 0 ? String(nextStage) : (rule.target == null ? '' : String(rule.target));
    row.appendChild(target);
    row.appendChild(el('button', { class: 'btn btn--ghost rule-remove', type: 'button', text: 'Remove' }));
    row.querySelector('.rule-remove').addEventListener('click', () => row.remove());
    return row;
  }
  function renderGroup(stageIndex, group = {}) {
    const card = el('details', { class: 'builder-card group-card', open: group.open === false ? null : 'open' });
    card.dataset.group = 'true';
    const summary = el('summary', { class: 'group-card__summary' }, [
      el('span', { class: 'group-card__title', text: group.name || 'New group' }),
      el('span', { class: 'group-card__meta', text: `${group.numberTeams || '—'} teams` }),
      el('button', { class: 'btn btn--ghost group-remove', type: 'button', text: 'Remove' }),
    ]);
    summary.querySelector('.group-remove').addEventListener('click', (event) => {
      event.preventDefault();
      card.remove();
    });
    card.appendChild(summary);
    const content = el('div', { class: 'group-card__content' });
    const name = input('Group name (optional)', 'name', 'text', { maxlength: '80', value: group.name || '' });
    const count = input('Teams in group', 'numberTeams', 'number', { required: 'required', min: '3', max: '256', value: group.numberTeams || '' });
    content.appendChild(el('div', { class: 'form-grid' }, [name, count]));
    content.appendChild(el('h4', { text: 'Direct advancing ranks' }));
    const rules = el('div', { class: 'rules-list' });
    (group.rules || []).forEach((rule) => rules.appendChild(renderRule(stageIndex, rule)));
    content.appendChild(rules);
    content.appendChild(el('button', { class: 'btn btn--ghost rule-add', type: 'button', text: '+ Add rank range' }));
    content.appendChild(el('div', { class: 'best-ranking' }, [
      el('h4', { text: 'Optional best-ranking places' }),
      el('p', { class: 'field__hint', text: 'Pool a rank range (for example, ranks 2–3) across groups. Set the total number selected in the stage settings.' }),
      el('label', { class: 'check-row best-ranking__toggle' }, [
        el('input', { type: 'checkbox', name: 'bestRankingEnabled', checked: group.bestRankingEnabled ? 'checked' : null }),
        ' Allow teams from this group to qualify by ranking',
      ]),
      el('div', { class: 'form-grid' }, [
        input('Candidate ranks from', 'bestFrom', 'number', { min: 1, value: group.bestFrom || group.bestRank || 3 }),
        input('Candidate ranks to', 'bestTo', 'number', { min: 1, value: group.bestTo || group.bestRank || 3 }),
      ]),
      select('Best-ranking target stage', 'bestTarget', targetOptions(stageIndex)),
    ]));
    card.appendChild(content);
    const rankingToggle = card.querySelector('[name="bestRankingEnabled"]');
    const bestTarget = card.querySelector('[name="bestTarget"]');
    const nextStage = stages.findIndex((stage, index) => index > stageIndex);
    if (group.bestTarget == null && nextStage >= 0) bestTarget.value = String(nextStage);
    const rankingFields = [
      card.querySelector('[name="bestFrom"]'),
      card.querySelector('[name="bestTo"]'),
      card.querySelector('[name="bestTarget"]'),
    ];
    const updateRankingFields = () => {
      rankingFields.forEach((field) => {
        field.disabled = !rankingToggle.checked;
        field.closest('.field').hidden = !rankingToggle.checked;
      });
    };
    rankingToggle.addEventListener('change', updateRankingFields);
    updateRankingFields();
    card.querySelector('.rule-add').addEventListener('click', () => rules.appendChild(renderRule(stageIndex)));
    count.querySelector('input').addEventListener('input', () => {
      card.querySelector('.group-card__meta').textContent = `${count.querySelector('input').value || '—'} teams`;
    });
    return card;
  }
  function groupPresetOptions(teamCount) {
    if (!Number.isInteger(teamCount) || teamCount < 6) return [];
    const options = [];
    for (let groups = 2; groups <= Math.min(8, teamCount); groups += 1) {
      if (teamCount % groups !== 0) continue;
      const teamsPerGroup = teamCount / groups;
      if (teamsPerGroup < 3) continue;
      options.push({
        groups,
        teamsPerGroup,
        description: `${groups} groups x ${teamsPerGroup} teams`,
      });
    }
    return options
      .sort((a, b) => Math.abs(a.teamsPerGroup - 4.5) - Math.abs(b.teamsPerGroup - 4.5) || a.groups - b.groups)
      .slice(0, 4);
  }
  function applyGroupPreset(preset) {
    readFormat();
    if (!stages.length) stages.push({ name: 'Group stage', type: 'league', groups: [] });
    const stage = stages[0];
    stage.name = stage.name || 'Group stage';
    stage.type = 'league';
    stage.groups = Array.from({ length: preset.groups }, (_, index) => ({
      name: `Group ${index + 1}`,
      numberTeams: preset.teamsPerGroup,
      rules: [{ from: 1, to: 2, target: null }],
      bestRankingEnabled: false,
      bestFrom: 3,
      bestTo: 3,
      bestTarget: null,
    }));
    stage.rounds = [];
    renderFormat();
  }
  function renderStage(stage, index) {
    const card = el('article', { class: 'builder-card stage-card' });
    card.dataset.stage = 'true';
    card.dataset.stageIndex = String(index);
    const stageSettings = stage.settings || {};
    const title = el('h2', { text: `${index + 1}. ${stage.name || 'New stage'}` });
    card.appendChild(el('div', { class: 'builder-card__head' }, [title, el('button', { class: 'btn btn--ghost stage-remove', type: 'button', text: 'Remove stage' })]));
    card.appendChild(el('div', { class: 'form-grid' }, [
      input('Stage name', 'name', 'text', { required: 'required', value: stage.name || '' }),
      select('Stage type', 'type', [['league', 'League / groups'], ['knockout', 'Knockout']]),
    ]));
    const type = card.querySelector('[name="type"]'); type.value = stage.type;
    const settingsPanel = el('div', { class: 'stage-settings' });
    settingsPanel.appendChild(el('h3', { text: 'Stage settings' }));
    settingsPanel.appendChild(el('div', { class: 'form-grid' }, [
      input('Matches per pairing', 'headToHeadMatches', 'number', { min: 1, value: stageSettings.headToHeadMatches || 1 }),
      input('Best-ranking places (stage total)', 'advancingTeamsFromRanking', 'number', { min: 0, value: stageSettings.advancingTeamsFromRanking || 0 }),
    ]));
    if (stage.type === 'league') {
      settingsPanel.appendChild(el('div', { class: 'form-grid' }, [
        input('Points for a win', 'pointsWin', 'number', { min: 0, value: stageSettings.points?.win ?? 3 }),
        input('Points for a draw', 'pointsDraw', 'number', { min: 0, value: stageSettings.points?.draw ?? 1 }),
        input('Points for a loss', 'pointsLoss', 'number', { min: 0, value: stageSettings.points?.loss ?? 0 }),
      ]));
      settingsPanel.appendChild(renderTiebreakers(stageSettings));
    }
    settingsPanel.appendChild(el('div', { class: 'check-row' }, [
      el('label', {}, [el('input', { type: 'checkbox', name: 'extraTime', checked: stageSettings.extraTime ? 'checked' : null }), ' Extra time']),
      el('label', {}, [el('input', { type: 'checkbox', name: 'penalties', checked: stageSettings.penalties ? 'checked' : null }), ' Penalties']),
    ]));
    card.appendChild(settingsPanel);
    const entries = el('div', { class: `stage-entries${stage.type === 'league' ? ' stage-entries--groups' : ''}` });
    const addEntry = () => {
      if (stage.type !== 'league') {
        entries.appendChild(renderRound());
        return;
      }
      readFormat();
      const previous = stage.groups[stage.groups.length - 1] || {};
      entries.appendChild(renderGroup(index, {
        ...previous,
        name: '',
        rules: (previous.rules || [{ from: 1, to: 2, target: null }]).map((rule) => ({ ...rule })),
        bestRankingEnabled: previous.bestRankingEnabled === true,
      }));
    };
    if (stage.type === 'league') {
      (stage.groups || []).forEach((g, groupIndex) => entries.appendChild(renderGroup(index, {
        ...g,
        open: groupIndex === 0,
      })));
    }
    else (stage.rounds || []).forEach((r) => entries.appendChild(renderRound(r)));
    card.appendChild(el('div', { class: 'builder-card__head' }, [el('h3', { text: stage.type === 'league' ? 'League groups' : 'Knockout rounds' }), el('button', { class: 'btn btn--ghost entry-add', type: 'button', text: stage.type === 'league' ? '+ Add group' : '+ Add round' })]));
    card.appendChild(entries);
    card.querySelector('.entry-add').addEventListener('click', addEntry);
    card.querySelector('.stage-remove').addEventListener('click', () => {
      readFormat();
      stages.splice(index, 1);
      activeStageIndex = Math.max(0, Math.min(activeStageIndex, stages.length - 1));
      renderFormat();
    });
    type.addEventListener('change', () => { stage.type = type.value; stage.groups = []; stage.rounds = []; renderFormat(); });
    return card;
  }
  function renderRound(round = {}) {
    const row = el('div', { class: 'round-row' });
    row.appendChild(input('Round name', 'name', 'text', { required: 'required', value: round.name || '' }));
    row.appendChild(el('button', { class: 'btn btn--ghost round-remove', type: 'button', text: 'Remove' }));
    row.querySelector('.round-remove').addEventListener('click', () => row.remove());
    return row;
  }
  function renderFormat() {
    clear(format); format.appendChild(el('h2', { text: 'Build your competition' })); format.appendChild(el('p', { text: 'Add stages in order, then configure groups, advancement and knockout rounds.' }));
    const teamCount = Number(form.elements.tournamentNumberOfTeams.value);
    const presets = groupPresetOptions(teamCount);
    if (presets.length) {
      const presetButtons = presets.map((preset) => el('button', {
        class: 'btn btn--ghost preset-button',
        type: 'button',
        text: `${preset.groups} groups of ${preset.teamsPerGroup}`,
        onclick: () => applyGroupPreset(preset),
      }));
      format.appendChild(el('div', { class: 'format-presets' }, [
        el('div', {}, [
          el('h3', { text: 'Quick group formats' }),
          el('p', { class: 'field__hint', text: `Balanced suggestions for ${teamCount} teams. You can customize groups and advancement afterwards.` }),
        ]),
        el('div', { class: 'format-presets__buttons' }, presetButtons.map((button, index) => el('div', { class: 'preset-option' }, [
          button,
          el('span', { class: 'preset-option__hint', text: presets[index].description }),
        ]))),
      ]));
    }
    const workspace = el('div', { class: 'stage-workspace' });
    const navigation = el('nav', { class: 'stage-nav', 'aria-label': 'Tournament stages' });
    stages.forEach((stage, index) => {
      navigation.appendChild(el('button', {
        class: `stage-nav__item${activeStageIndex === index ? ' stage-nav__item--active' : ''}`,
        type: 'button',
        text: `${index + 1}. ${stage.name || 'Untitled stage'}`,
        onclick: () => {
          readFormat();
          activeStageIndex = index;
          renderFormat();
        },
      }));
    });
    navigation.appendChild(el('button', {
      class: 'btn btn--ghost stage-nav__add',
      type: 'button',
      text: '+ Add stage',
      onclick: () => {
        readFormat();
        stages.push({ name: '', type: 'league', groups: [] });
        activeStageIndex = stages.length - 1;
        renderFormat();
      },
    }));
    workspace.appendChild(navigation);
    const editor = el('div', { class: 'stage-editor' });
    if (stages[activeStageIndex]) editor.appendChild(renderStage(stages[activeStageIndex], activeStageIndex));
    workspace.appendChild(editor);
    format.appendChild(workspace);
  }
  function readFormat() {
    const cards = [...format.querySelectorAll('.stage-card')];
    cards.forEach((card) => {
      const i = Number(card.dataset.stageIndex);
      const value = (name) => card.querySelector(`[name="${name}"]`)?.value;
      const stage = stages[i]; stage.name = value('name').trim(); stage.type = value('type');
      stage.settings = {
        headToHeadMatches: Number(value('headToHeadMatches')) || 1,
        advancingTeamsFromRanking: Number(value('advancingTeamsFromRanking')) || 0,
        extraTime: !!card.querySelector('[name="extraTime"]')?.checked,
        penalties: !!card.querySelector('[name="penalties"]')?.checked,
      };
      if (stage.type === 'league') {
        stage.settings.points = {
          win: Number(value('pointsWin')) || 0,
          draw: Number(value('pointsDraw')) || 0,
          loss: Number(value('pointsLoss')) || 0,
        };
        stage.settings.tiebreakers = [...card.querySelectorAll('.tiebreaker-row')].map((row) => ({
          type: row.querySelector('[name="tiebreakerType"]').value,
          priority: Number(row.querySelector('[name="tiebreakerPriority"]').value),
        }));
      }
      if (stage.type === 'league') {
        stage.groups = [...card.querySelectorAll('.group-card')].map((g) => ({
          name: g.querySelector('[name="name"]').value.trim(), numberTeams: Number(g.querySelector('[name="numberTeams"]').value),
          rules: [...g.querySelectorAll('.rule-row')].map((r) => ({ from: Number(r.querySelector('[name="from"]').value), to: Number(r.querySelector('[name="to"]').value), target: r.querySelector('[name="target"]').value === '' ? null : Number(r.querySelector('[name="target"]').value) })),
          bestRankingEnabled: g.querySelector('[name="bestRankingEnabled"]').checked,
          bestFrom: Number(g.querySelector('[name="bestFrom"]').value) || 3,
          bestTo: Number(g.querySelector('[name="bestTo"]').value) || 3,
          bestTarget: g.querySelector('[name="bestTarget"]').value === '' ? null : Number(g.querySelector('[name="bestTarget"]').value),
        }));
        stage.groups.forEach((group, groupIndex) => {
          group.name = group.name || `Group ${groupIndex + 1}`;
        });
      } else {
        stage.rounds = [...card.querySelectorAll('.round-row')].map((r) => ({ name: r.querySelector('[name="name"]').value.trim() }));
      }
    });
  }
  function validateGeneral() {
    const name = form.elements.tournamentName.value.trim(); const teams = Number(form.elements.tournamentNumberOfTeams.value);
    if (!name) return 'Tournament name is required.'; if (!Number.isInteger(teams) || teams < 3 || teams > 256) return 'Number of teams must be between 3 and 256.'; return null;
  }
  function validateFormat() {
    if (!stages.length) return 'Add at least one stage.';
    for (const [stageIndex, stage] of stages.entries()) {
      if (!stage.name) return `Stage ${stageIndex + 1} needs a name.`;
      if (stage.type === 'knockout' && !stage.rounds.length) return `${stage.name} needs at least one round.`;
      if (stage.type !== 'league') {
        if (stage.rounds.some((round) => !round.name)) return `${stage.name} has a round without a name.`;
        continue;
      }
      if (!stage.groups.length) return `${stage.name} needs at least one group.`;
      const priorities = stage.settings.tiebreakers.map((rule) => rule.priority);
      if (!stage.settings.tiebreakers.length) return `${stage.name} needs at least one group tiebreaker.`;
      if (priorities.some((priority) => !Number.isInteger(priority) || priority < 1) ||
          new Set(priorities).size !== priorities.length) {
        return `${stage.name} has invalid or duplicate tiebreaker priorities.`;
      }
      if (stage.settings.advancingTeamsFromRanking < 0) return `${stage.name} cannot have a negative ranking quota.`;
      for (const group of stage.groups) {
        if (!Number.isInteger(group.numberTeams) || group.numberTeams < 3) return `${group.name} needs at least 3 teams.`;
        for (const rule of group.rules) {
          if (!Number.isInteger(rule.from) || !Number.isInteger(rule.to) || rule.from < 1 || rule.to < rule.from || rule.to > group.numberTeams) {
            return `${group.name} has an invalid advancing rank range.`;
          }
          if (rule.target === null) return `Choose a target stage for every advancing range in ${group.name}.`;
        }
        if (stage.settings.advancingTeamsFromRanking > 0 && group.bestRankingEnabled && group.bestTarget !== null &&
            (!Number.isInteger(group.bestFrom) || !Number.isInteger(group.bestTo) ||
             group.bestFrom < 1 || group.bestTo < group.bestFrom || group.bestTo > group.numberTeams)) {
          return `${group.name} has an invalid best-ranking candidate range.`;
        }
      }
      if (stage.settings.advancingTeamsFromRanking > 0 &&
          !stage.groups.some((group) => group.bestRankingEnabled && group.bestTarget !== null)) {
        return `Choose at least one best-ranking candidate target in ${stage.name}.`;
      }
    }
    return null;
  }
  async function submit() {
    readFormat();
    const error = validateGeneral() || validateFormat();
    if (error) { showBanner(banner, error); return; }
    next.disabled = true; next.textContent = 'Creating…'; showBanner(banner, '');
    try {
      const base = await Api.tournaments.create({
        name: form.elements.tournamentName.value.trim(),
        slug: form.elements.tournamentSlug.value.trim() || undefined,
        place: form.elements.tournamentPlace.value.trim() || undefined,
        visibility: form.elements.tournamentVisibility.value,
        numberOfTeams: Number(form.elements.tournamentNumberOfTeams.value),
      });
      const tournamentId = base.tournament.id; const ids = [];
      for (let i = 0; i < stages.length; i += 1) {
        const response = await Api.stages.add(tournamentId, { type: stages[i].type, sequenceOrder: i + 1, settings: stages[i].settings });
        const found = (response?.stages || []).find((s) => s.sequenceOrder === i + 1);
        if (!found?.id) throw new Error(`Stage ${i + 1} could not be created.`);
        ids.push(found.id);
      }
      for (let i = 0; i < stages.length; i += 1) {
        const stage = stages[i];
        if (stage.type === 'knockout') { for (let r = 0; r < stage.rounds.length; r += 1) await Api.rounds.add(tournamentId, ids[i], { name: stage.rounds[r].name, sequenceOrder: r + 1 }); continue; }
        for (let g = 0; g < stage.groups.length; g += 1) {
          const group = stage.groups[g];
          const response = await Api.groups.add(tournamentId, ids[i], { name: group.name, sequenceOrder: g + 1, number_teams: group.numberTeams, advancing_teams: 0, promotion_rules: '[]' });
          const rules = group.rules.filter((r) => r.target !== null).map((r) => ({ from: r.from, to: r.to, stage: ids[r.target] }));
          if (group.bestRankingEnabled && group.bestTarget !== null) {
            rules.push({ from: group.bestFrom, to: group.bestTo, stage: ids[group.bestTarget], rank: true });
          }
          if (rules.length) await Api.groups.update(tournamentId, response.group.id, { promotion_rules: JSON.stringify(rules) });
        }
      }
      location.href = `/tournament?id=${encodeURIComponent(tournamentId)}`;
    } catch (err) { showBanner(banner, friendlyErrorMessage(err)); next.disabled = false; next.textContent = 'Create tournament'; }
  }
  function advanceWizard() {
    if (phase === 1) {
      const error = validateGeneral();
      if (error) {
        showBanner(banner, error);
        return;
      } 
      phase = 2;
      general.hidden = true;
      format.hidden = false;
      back.hidden = false;
      next.textContent = 'Create tournament';
      if (!stages.length) 
        stages.push({ name: '', type: 'league', groups: [] });
      renderFormat(); renderSteps(); 
    } else {
      submit();
    }
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    advanceWizard();
  });
  back.addEventListener('click', () => { phase = 1; general.hidden = false; format.hidden = true; back.hidden = true; next.textContent = 'Build format'; renderSteps(); });
  renderGeneral(); renderSteps();
})();
