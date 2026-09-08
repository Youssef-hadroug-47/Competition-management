/* ---------------------------------------------------------------------
 * app.js — hash router + topbar. This is the only file that decides
 * *which* view runs; views.js decides what each screen looks like.
 * ------------------------------------------------------------------- */

function go(hash) {
  location.hash = hash;
}
window.go = go;

function renderTopbar() {
  const bar = document.getElementById('topbar');
  const user = API.getUser();
  const parts = location.hash.slice(1).split('/').filter(Boolean);
  const activeTop = parts[0] || (user ? 'tournaments' : 'login');

  bar.innerHTML = `
    <span class="brand">🏆 Tournament Manager</span>
    ${user ? `
      <nav>
        <span class="navlink ${activeTop === 'tournaments' ? 'active' : ''}" id="nav-tournaments">Tournaments</span>
        ${API.hasRole('admin') ? `<span class="navlink ${activeTop === 'admin' ? 'active' : ''}" id="nav-admin">Users</span>` : ''}
      </nav>` : ''}
    <span class="spacer"></span>
    <input class="baseurl" id="baseurl-input" value="${UI.esc(API.getBaseUrl())}" title="API base URL — where the backend is running">
    ${user ? `<span class="user-chip">${UI.esc(user.name)} ${UI.roleBadge(user.role)} <button class="small ghost" id="logout-btn">Logout</button></span>` : ''}
  `;

  if (user) {
    UI.qs('#nav-tournaments', bar).addEventListener('click', () => go('#/tournaments'));
    const navAdmin = UI.qs('#nav-admin', bar);
    if (navAdmin) navAdmin.addEventListener('click', () => go('#/admin/users'));
    UI.qs('#logout-btn', bar).addEventListener('click', () => {
      API.setToken(null);
      API.setUser(null);
      UI.toast('Logged out', 'success');
      go('#/login');
      route();
    });
  }
  UI.qs('#baseurl-input', bar).addEventListener('change', (e) => {
    API.setBaseUrl(e.target.value.trim());
    UI.toast('API base URL updated', 'success');
  });
}

function route() {
  renderTopbar();
  const container = document.getElementById('app');
  const parts = location.hash.slice(1).split('/').filter(Boolean);
  const loggedIn = API.isLoggedIn();

  if (!loggedIn) {
    if (parts[0] === 'register') return VIEWS.register(container);
    return VIEWS.login(container);
  }
  if (!parts.length || parts[0] === 'login' || parts[0] === 'register') {
    go('#/tournaments');
    return;
  }
  if (parts[0] === 'tournaments') {
    if (parts[1] === 'new') return VIEWS.newTournament(container);
    if (parts[1]) return VIEWS.tournamentDetail(container, parts[1], parts[2]);
    return VIEWS.tournamentList(container);
  }
  if (parts[0] === 'admin' && parts[1] === 'users') return VIEWS.adminUsers(container);

  container.innerHTML = '<p class="empty">Page not found.</p>';
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', () => {
  if (!localStorage.getItem('tm_base_url')) API.setBaseUrl('http://localhost:3000/api');
  route();
});
