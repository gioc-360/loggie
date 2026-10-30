// The window, folder, voice, and permission doors.
// Moved out of main.js in debt-cleanup 6.6.
import { shell } from 'electron';
import { folderAccess, voiceInput, handleSecure, handleTrusted } from './main-state.js';
import { panelWindow, togglePanelFullScreen, hideLoggie } from './main-windows.js';

export function registerAppIpc() {
  handleTrusted('loggie:minimize-panel', () => panelWindow?.minimize());
  handleTrusted('loggie:toggle-full-screen', () => togglePanelFullScreen());
  handleSecure('loggie:start-dictation', () => voiceInput.start());
  handleSecure('loggie:stop-dictation', () => voiceInput.stop());
  handleSecure('folders:status', () => folderAccess.status());
  handleSecure('folders:allow-defaults', () => folderAccess.allowDefaults());
  handleSecure('voice:authorize', () => voiceInput.start({ authorizeOnly: true }));
  handleSecure('permissions:settings', (permission) => {
    const panes = { folders: 'Privacy_FilesAndFolders', microphone: 'Privacy_Microphone', speech: 'Privacy_SpeechRecognition', screen: 'Privacy_ScreenCapture', calendars: 'Privacy_Calendars' };
    if (!Object.hasOwn(panes, permission)) throw new Error('Unsupported permission.');
    return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?' + panes[permission]);
  });
  handleSecure('folders:choose', () => folderAccess.choose());
  handleTrusted('loggie:hide', () => hideLoggie());
}
