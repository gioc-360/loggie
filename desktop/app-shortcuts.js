// Register the one global summon shortcut; the Dock and menu bar remain available if another app owns it.
export function registerSummonShortcut({ globalShortcut, shortcut, togglePanel, dialog, platform = process.platform }) {
  const registered = globalShortcut.register(shortcut, () => {
    Promise.resolve().then(togglePanel).catch(error => console.error(`Could not summon Loggie: ${error.message}`));
  });
  if (!registered) {
    const keys = platform === 'darwin' ? '⌘⇧L' : 'Ctrl+Shift+L';
    console.warn(`Could not register the ${shortcut} shortcut.`);
    dialog.showMessageBox({
      type: 'warning', title: 'Loggie shortcut unavailable',
      message: `Loggie could not register ${keys}.`,
      detail: 'Another app may be using this shortcut. You can still open Loggie from the Dock or menu bar.',
      buttons: ['OK'],
    }).catch(error => console.error(`Could not show shortcut notice: ${error.message}`));
  }
  return registered;
}
