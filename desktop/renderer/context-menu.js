// One right-click listener for the panel (loggie right-click, 2026-10-28; ~/Loggie/workspace/right-click-proposal.md).
// A text field, or the selected text under the pointer, gets the Mac's own Cut, Copy, Paste and Select All. A thing a
// view registered (a recording; a workspace row and a move as their views register) gets its own menu: the view says
// which items can run (context-menu-model.js menuFor), main draws the Mac's menu, and the pick runs the view's own
// table, each id the function its visible control calls. Anything else gets no menu. Secondary click, two-finger tap,
// ctrl-click and Shift+F10 all reach Chromium's one contextmenu event.
import { menuFor } from './context-menu-model.js';

// { kind, find(node) -> the thing's id or null, state(id) -> what menuFor reads, run(id, pick), failed(error) }
const providers = [];
export function registerMenu(provider) {
  providers.push(provider);
  return () => { const at = providers.indexOf(provider); if (at >= 0) providers.splice(at, 1); };
}

const TEXT_FIELD = 'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="number"], input[type="password"]';
// A text field (with what it can do now), the focused editable text (a title being renamed, a line being fixed), or
// selected text holding the pointer; else null.
export function textTarget(node, { active = document.activeElement, selection = window.getSelection?.() } = {}) {
  const field = node.closest(TEXT_FIELD);
  if (field) {
    let selected = false;
    try { selected = field.selectionStart !== field.selectionEnd; } catch { selected = false; }
    return { editable: !field.disabled && !field.readOnly, selected };
  }
  const chosen = Boolean(selection && String(selection).trim() && selection.containsNode?.(node, true));
  const editing = node.closest('[contenteditable]:not([contenteditable="false"])');
  if (editing && active && (editing === active || editing.contains(active))) return { editable: true, selected: chosen };
  return chosen ? { editable: false, selected: true } : null;
}

// `popup(menu)` is the main door (hikyaku:context-menu): it answers { id, value }, or { id: null } on Esc.
export function attachContextMenu({ root = document, popup }) {
  root.addEventListener('contextmenu', async (event) => {
    const node = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (!node) return;
    const text = textTarget(node);
    if (text) {
      event.preventDefault();
      await Promise.resolve(popup({ kind: 'text', target: null, items: menuFor('text', text) })).catch(() => null);
      return;
    }
    for (const provider of providers) {
      const id = provider.find(node);
      if (id == null) continue;
      event.preventDefault();
      let picked = null;
      try { picked = await popup({ kind: provider.kind, target: { id }, items: menuFor(provider.kind, provider.state(id)) }); }
      catch (error) { provider.failed?.(error); return; }
      if (picked?.id) await provider.run(id, picked);
      return;
    }
  });
}
