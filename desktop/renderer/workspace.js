const navigation = [...document.querySelectorAll('[data-view]')];
const pages = [...document.querySelectorAll('[data-page]')];
// The gear opens Settings in one press; pressing it again on Settings stays there (2026-10-28: the dots menu held
// only Settings). It is a [data-view] button, so it lights like a tab while Settings is open.
function navigate(view) {
  if (!pages.some(page => page.dataset.page === view)) return;
  pages.forEach(page => { page.hidden = page.dataset.page !== view; });
  navigation.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
  document.querySelector('#conversation').scrollTop = 0;
}
navigation.forEach(button => button.addEventListener('click', () => navigate(button.dataset.view)));
document.querySelector('#brandHome')?.addEventListener('click', () => navigate('today'));
// detail is a view name, or { view, call, picker } to open one call on the Notes & Meetings tab (meetings.js listens).
document.addEventListener('loggie:navigate', event => {
  const detail = typeof event.detail === 'string' ? { view: event.detail } : (event.detail || {});
  navigate(detail.view);
  if (detail.call) document.dispatchEvent(new CustomEvent('loggie:open-call', { detail: { call: detail.call, picker: Boolean(detail.picker) } }));
  // One workspace's page (Meetings' "Open the workspace" after filing, cycle 2).
  if (detail.workspace) document.dispatchEvent(new CustomEvent('loggie:open-workspace', { detail: { name: detail.workspace } }));
});
// The Today tab's count is what waits for the user (panel.js renderQueue), set there.
