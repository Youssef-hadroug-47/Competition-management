(function () {
  const STORAGE_KEY = 'tournly:theme';
  const themes = new Set(['light', 'dark']);
  function getStoredTheme() {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return themes.has(stored) ? stored : null;
  }

  function currentTheme() {
    return document.documentElement.dataset.theme || 'light';
  }

  function updateControls() {
    const dark = currentTheme() === 'dark';
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      button.setAttribute('aria-pressed', String(dark));
      button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
      button.setAttribute('title', dark ? 'Switch to light mode' : 'Switch to dark mode');
      const label = button.querySelector('[data-theme-label]');
      if (label) label.textContent = dark ? 'Light mode' : 'Dark mode';
      const icon = button.querySelector('[data-theme-icon]');
      if (icon) icon.textContent = dark ? '☀' : '☾';
    });
  }

  function apply(theme, persist = true) {
    const next = themes.has(theme) ? theme : 'light';
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    if (persist) window.localStorage.setItem(STORAGE_KEY, next);
    updateControls();
  }

  function toggle() {
    apply(currentTheme() === 'dark' ? 'light' : 'dark');
  }

  function createToggle() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-toggle btn btn--ghost';
    button.dataset.themeToggle = '';
    button.setAttribute('aria-pressed', 'false');
    button.innerHTML = '<span data-theme-icon aria-hidden="true">☾</span><span data-theme-label>Dark mode</span>';
    button.addEventListener('click', toggle);
    return button;
  }

  // Keep the familiar light theme as the default. The user can switch modes
  // explicitly, and the choice is retained for later visits.
  apply(getStoredTheme() || 'light', false);

  document.addEventListener('DOMContentLoaded', () => {
    if (!document.querySelector('[data-theme-toggle]')) {
      const toggleButton = createToggle();
      toggleButton.classList.add('theme-toggle--floating');
      document.body.appendChild(toggleButton);
    }
    updateControls();
  });

  window.Theme = { apply, toggle, createToggle, current: currentTheme };
})();
