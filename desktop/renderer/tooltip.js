// One tooltip for the whole panel (FA build loggie-availability; Gio, 2026-10-21: "im not seeing the tool tips"). The
// Mac shows a native title only after a still second, and only when the app is in front; this chip shows at once on
// hover and on keyboard focus, with no fade, no transition and no delay, and hides on leave, blur, Escape and scroll.
// Which elements: every icon-only button that has a title (its title moves into data-tip, so there is never a second,
// native tooltip), and any element that carries data-tip. One MutationObserver adopts buttons drawn or retitled later.
// aria-labels are never touched.
const GAP = 6;
const EDGE = 4;

// Icon-only: no letter or digit once its icons and aria-hidden parts are taken out (the check:clicks rule).
export function iconOnly(node) {
  const copy = node.cloneNode(true);
  copy.querySelectorAll('[aria-hidden="true"], svg, img').forEach((part) => part.remove());
  return !/[\p{L}\p{N}]/u.test(copy.textContent);
}

// An icon-only button's title becomes its data-tip; a title on anything else stays the Mac's own.
export function adopt(node) {
  if (!(node instanceof HTMLButtonElement) || !node.hasAttribute('title')) return false;
  const text = node.getAttribute('title').trim();
  if (!text || !iconOnly(node)) return false;
  node.dataset.tip = text;
  node.removeAttribute('title');
  return true;
}

export function attachTooltip(root = document.body) {
  const tip = document.createElement('div');
  tip.className = 'loggie-tip';
  tip.setAttribute('role', 'tooltip');
  tip.setAttribute('aria-hidden', 'true');
  tip.hidden = true;
  document.body.append(tip);
  let current = null;

  const hide = () => { current = null; tip.hidden = true; };
  const show = (target) => {
    const text = target?.dataset.tip?.trim();
    if (!text) { hide(); return; }
    current = target;
    tip.textContent = text;
    tip.hidden = false;
    // Above the element, below it when there is no room above, and kept inside the window from side to side.
    const at = target.getBoundingClientRect();
    const { width, height } = tip.getBoundingClientRect();
    let top = at.top - GAP - height;
    if (top < EDGE) top = at.bottom + GAP;
    const left = Math.min(Math.max(EDGE, at.left + at.width / 2 - width / 2), Math.max(EDGE, window.innerWidth - width - EDGE));
    tip.style.top = `${Math.round(top)}px`;
    tip.style.left = `${Math.round(left)}px`;
    tip.dataset.side = top > at.top ? 'below' : 'above';
  };
  const targetOf = (node) => {
    const found = node instanceof Element ? node.closest('[data-tip], button[title]') : null;
    if (found && !found.dataset.tip) adopt(found);
    return found?.dataset.tip ? found : null;
  };

  const sweep = (node) => {
    if (!(node instanceof Element)) return;
    adopt(node);
    node.querySelectorAll('button[title]').forEach(adopt);
  };
  sweep(root);
  new MutationObserver((records) => {
    let retitled = false;
    for (const record of records) {
      if (tip.contains(record.target)) continue;
      if (record.type === 'attributes') { sweep(record.target); retitled ||= record.target === current; }
      else record.addedNodes.forEach(sweep);
    }
    // A redraw that took the element away takes its tooltip too; a new label on the shown one shows at once.
    if (current && !current.isConnected) hide();
    else if (retitled) show(current);
  }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['title', 'data-tip'] });

  document.addEventListener('pointerover', (event) => {
    const target = targetOf(event.target);
    if (target !== current) { if (target) show(target); else hide(); }
  }, true);
  document.addEventListener('pointerout', (event) => {
    if (current && !(event.relatedTarget instanceof Node && current.contains(event.relatedTarget))) hide();
  }, true);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('focusin', (event) => {
    const target = targetOf(event.target);
    let keyboard = false;
    try { keyboard = event.target.matches(':focus-visible'); } catch { keyboard = false; }
    if (target && keyboard) show(target);
  }, true);
  document.addEventListener('focusout', (event) => { if (current && current.contains(event.target)) hide(); }, true);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hide(); }, true);
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
  return { tip, show, hide };
}
