(function () {
  const { el, clear, showBanner, friendlyErrorMessage } = UI;

  function playerDetailsFields() {
    return el('div', { class: 'management-form-grid' }, [
      playerField('Name', 'text', 'name', 'Player name', true),
      playerField('Slug', 'text', 'slug', 'Auto-generated if empty'),
      playerField('Nickname', 'text', 'nickname', 'Optional'),
      playerField('Date of birth', 'date', 'dateOfBirth', ''),
      playerField('Nationality', 'text', 'nationality', 'Optional'),
      playerField('Position', 'text', 'position', 'Optional'),
      playerField('Preferred foot', 'text', 'preferredFoot', 'Left, right, both…'),
      playerField('Height (cm)', 'number', 'heightCm', 'Optional', false, { min: 1, max: 300 }),
      playerField('Shirt number', 'number', 'shirtNumber', 'Optional', false, { min: 1, max: 99 }),
      el('div', { class: 'field' }, [
        el('label', { text: 'Role' }),
        el('select', { name: 'role' }, [
          el('option', { value: 'player', text: 'Player' }),
          el('option', { value: 'captain', text: 'Captain' }),
          el('option', { value: 'goalkeeper', text: 'Goalkeeper' }),
        ]),
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: 'Status' }),
        el('select', { name: 'status' }, [
          el('option', { value: 'active', text: 'Active' }),
          el('option', { value: 'injured', text: 'Injured' }),
          el('option', { value: 'suspended', text: 'Suspended' }),
          el('option', { value: 'ineligible', text: 'Ineligible' }),
        ]),
      ]),
    ]);
  }

  function playerField(label, type, name, placeholder, required = false, extra = {}) {
    return el('div', { class: 'field' }, [
      el('label', { text: label }),
      el('input', {
        type,
        name,
        placeholder: placeholder || '',
        ...(required ? { required: 'required' } : {}),
        ...extra,
      }),
    ]);
  }

  function renderRedeemer(container, { onRedeemed } = {}) {
    const banner = document.getElementById('banner');
    const section = el('section', { class: 'builder-card player-invite-redeemer' }, [
      el('div', { class: 'player-invite-redeemer__head' }, [
        el('span', { class: 'player-invite-redeemer__mark', 'aria-hidden': 'true', text: '↗' }),
        el('div', {}, [
          el('p', { class: 'eyebrow', text: 'Player registration' }),
          el('h2', { text: 'Join a team with an invite code' }),
          el('p', { class: 'field__hint', text: 'Enter a code from your team manager. Each account can join one team.' }),
        ]),
      ]),
      el('div', { class: 'player-invite-redeemer__body' }),
    ]);
    const body = section.querySelector('.player-invite-redeemer__body');
    (async () => {
      try {
        body.appendChild(el('p', { class: 'player-invite-redeemer__loading', text: 'Checking team availability…' }));
        const { available } = await Api.playerInviteCodes.availability();
        if (typeof available !== 'boolean') throw new Error('Team availability could not be checked.');
        if (available)
          container.appendChild(section);
        else return;
        
        const { membership } = Session.isAuthenticated()
          ? await Api.playerInviteCodes.membership()
          : { membership: null };
        clear(body);
        if (membership) {
          body.append(
            el('p', { class: 'player-invite-redeemer__notice', text: 'You are already registered with a team. This account can join only one team.' }),
            el('div', { class: 'player-invite-redeemer__membership' }, [
              el('strong', { text: membership.teamName }),
              el('span', { text: `${membership.tournamentName} · ${membership.playerName}` }),
            ]),
          );
          return;
        }


        if (!Session.isAuthenticated()) {
          body.append(
            el('p', { class: 'player-invite-redeemer__notice', text: 'Sign in to redeem a player invite code.' }),
            el('a', {
              class: 'btn btn--primary',
              href: `/login?next=${encodeURIComponent(location.pathname + location.search)}`,
              text: 'Sign in to continue',
            }),
          );
          return;
        }

        const codeForm = el('form', { class: 'player-invite-code-form' }, [
          playerField('Invite code', 'text', 'code', '16-character code', true, {
            maxlength: 16,
            minlength: 16,
            pattern: '[A-Fa-f0-9]{16}',
            autocomplete: 'off',
            autocapitalize: 'characters',
            spellcheck: 'false',
            'aria-describedby': 'player-invite-code-help',
          }),
          el('p', { id: 'player-invite-code-help', class: 'field__hint', text: 'Codes are single-use and expire after seven days.' }),
          el('button', { class: 'btn btn--primary', type: 'submit', text: 'Check code' }),
        ]);
        const formHost = el('div', { class: 'player-invite-redeemer__form', hidden: true });
        body.append(codeForm, formHost);
        codeForm.addEventListener('submit', async (event) => {
          event.preventDefault();
          const code = codeForm.elements.code.value.trim();
          const button = codeForm.querySelector('button[type="submit"]');
          button.disabled = true;
          showBanner(banner, '');
          try {
            const details = await Api.playerInviteCodes.validate(code);
            codeForm.hidden = true;
            formHost.hidden = false;
            const playerForm = el('form', { class: 'management-form roster-player-form' }, [
              el('div', { class: 'player-invite-redeemer__team' }, [
                el('span', { class: 'eyebrow', text: 'You are joining' }),
                el('strong', { text: details.teamName }),
                el('span', { class: 'field__hint', text: details.tournamentName }),
              ]),
              el('h3', { text: 'Your player details' }),
              playerDetailsFields(),
              el('button', { class: 'btn btn--primary', type: 'submit', text: 'Join this team' }),
              el('button', { class: 'btn btn--ghost', type: 'button', text: 'Use a different code' }),
            ]);
            formHost.appendChild(playerForm);
            playerForm.querySelector('button[type="button"]').addEventListener('click', () => {
              clear(formHost);
              formHost.hidden = true;
              codeForm.hidden = false;
              codeForm.elements.code.value = '';
              button.disabled = false;
              showBanner(banner, '');
            });
            playerForm.addEventListener('submit', async (submitEvent) => {
              submitEvent.preventDefault();
              const player = Object.fromEntries(new FormData(playerForm));
              if (player.shirtNumber) player.shirtNumber = Number(player.shirtNumber);
              if (player.heightCm) player.heightCm = Number(player.heightCm);
              const submitButton = playerForm.querySelector('button[type="submit"]');
              submitButton.disabled = true;
              try {
                await Api.playerInviteCodes.redeem(code, player);
              } catch (error) {
                showBanner(banner, friendlyErrorMessage(error));
                submitButton.disabled = false;
                return;
              }
              if (onRedeemed) {
                try {
                  await onRedeemed(details);
                } catch (error) {
                  showBanner(banner, `Player added, but the roster could not be refreshed. ${friendlyErrorMessage(error)}`);
                }
              } else {
                clear(body);
                body.append(
                  el('p', { class: 'player-invite-redeemer__notice', text: 'Registration complete. Your account can join only one team.' }),
                  el('div', { class: 'player-invite-redeemer__membership' }, [
                    el('strong', { text: details.teamName }),
                    el('span', { text: `${details.tournamentName} · ${player.name}` }),
                  ]),
                  el('a', { class: 'btn btn--secondary', href: '/index', text: 'Back to home' }),
                );
              }
            });
          } catch (error) {
            showBanner(banner, friendlyErrorMessage(error));
            button.disabled = false;
          }
        });
      } catch (error) {
        clear(body);
        showBanner(banner, friendlyErrorMessage(error));
        body.append(
          el('p', { class: 'player-invite-redeemer__notice', text: 'Team availability or your registration status could not be checked.' }),
          el('button', {
            class: 'btn btn--secondary',
            type: 'button',
            text: 'Try again',
            onClick: () => {
              section.remove();
              renderRedeemer(container, { onRedeemed });
            },
          }),
        );
      }
    })();
  }

  window.PlayerInvite = {
    playerDetailsFields,
    renderRedeemer,
  };
})();
