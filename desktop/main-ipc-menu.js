// The right-click doors (loggie right-click, 2026-10-28; ~/Loggie/workspace/right-click-proposal.md): the Mac's own
// menu drawn from the ids a page sent, Share, and Delete recording. The menu does no work: it answers one id, and the
// page calls the function its visible control already calls. Share is local: a compose window in his mail app, unsent,
// or the Mac's share sheet; nothing goes to a server. Delete hands the call's folder to the Trash, never rm.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dialog, Menu, ShareMenu, shell } from 'electron';
import { validateCallId, validateContextMenu, validateShare } from './ipc-validation.js';
import { popupMenu } from './menu-template.js';
import { shareCall, shareInfo } from '../src/hikyaku/call-share.js';
import { trashCall } from '../src/hikyaku/call-trash.js';
import { readSettings } from '../src/hikyaku/draft.js';
import { readWorkstreams } from '../src/hikyaku/workstreams.js';
import { coreClient, hikyakuDirectory, handleSecure, logUiAct } from './main-state.js';
import { panelWindow } from './main-windows.js';
import { ownAddresses } from './main-helpers.js';
import { sayChanged } from './main-catch-up.js';

// Who Share would reach and whether the call has notes, read here when a menu holds Share (the page gets a count).
async function shareFor(id) {
  const info = await shareInfo({ home: hikyakuDirectory(), id, own: await ownAddresses().catch(() => []) });
  return { people: info.people.length, notes: info.notes, app: (await readSettings(hikyakuDirectory())).mailApp };
}

export function registerMenuIpc() {
  // One menu at the pointer; Esc or a click away answers { id: null } and logs nothing.
  handleSecure('hikyaku:context-menu', async (menu) => {
    const input = validateContextMenu(menu);
    const started = Date.now();
    const share = ['recording', 'share'].includes(input.kind) ? await shareFor(input.target.id) : null;
    const picked = await popupMenu({ Menu, window: panelWindow, menu: input, share });
    if (picked.id) logUiAct({ act: 'menu', kind: input.kind, id: picked.id, ms: Date.now() - started });
    return picked;
  });
  // Share (the call page's Share button and Share ▸): the people on the call in his mail app, unsent, or the share
  // sheet. Logged as counts only.
  handleSecure('hikyaku:call-share', async (id, how) => {
    const input = validateShare(id, how);
    const settings = await readSettings(hikyakuDirectory());
    const result = await shareCall({ home: hikyakuDirectory(), ...input, own: await ownAddresses().catch(() => []), settings, tmp: tmpdir(),
      compose: async (command, args) => { spawn(command, args, { detached: true, stdio: 'ignore' }).unref?.(); },
      sheet: async (item) => { new ShareMenu(item).popup({ browserWindow: panelWindow }); } });
    logUiAct({ act: 'call-share', how: result.how, people: result.people });
    return result;
  });
  // Delete recording (the call page's quiet link and the menu's last line): refused while anything owns the call, then
  // the Mac's own confirm, then No workspace, then the folder to the Trash. Both tabs reload: the row is simply gone.
  handleSecure('hikyaku:call-trash', async (id) => {
    const home = hikyakuDirectory();
    const ask = { type: 'warning', buttons: ['Move to Trash', 'Cancel'], defaultId: 0, cancelId: 1, detail: 'Its notes and audio go with it. Its moves in its workspace are set aside, with Undo.' };
    const result = await trashCall({ home, id: validateCallId(id), core: coreClient, workstreams: await readWorkstreams(home),
      confirm: async ({ title }) => { const options = { ...ask, message: `Move “${title}” to the Trash?` }; return (await (panelWindow ? dialog.showMessageBox(panelWindow, options) : dialog.showMessageBox(options))).response === 0; },
      trash: (path) => shell.trashItem(path) });
    if (result.trashed) { logUiAct({ act: 'call-trash', setAside: result.setAside }); sayChanged(); }
    return result;
  });
}
