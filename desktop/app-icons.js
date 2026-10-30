// The setup page's app marks (first-run-polish B2.2): the installed app's own icon by id, read once per run. The
// renderer sends only an id; this file owns the paths. A missing app is not installed; an app whose icon cannot be read
// is installed with no icon, and the page then draws Gio's bundled mark. macOS answers an app it will not show with its
// generic app icon (seen 2026-10-18: Calendar, Outlook and Mail all came back as the same placeholder), so an icon
// equal to the generic one, read once from an empty .app folder and a missing .app, counts as no icon.
import { createHash } from 'node:crypto';

export const APP_PATHS = Object.freeze({
  outlook: '/Applications/Microsoft Outlook.app',
  'apple-mail': '/System/Applications/Mail.app',
  calendar: '/System/Applications/Calendar.app',
  'system-settings': '/System/Applications/System Settings.app',
  messages: '/System/Applications/Messages.app',
  whatsapp: '/Applications/WhatsApp.app',
});
const SIZE = { size: 'normal' };
const digest = (image) => createHash('sha256').update(image.toPNG()).digest('hex');

// getFileIcon(path, options) -> a NativeImage; stat(path) throws when the path is missing; makeProbe() -> { app, missing,
// remove }: an empty X.app folder, a .app path that does not exist, and how to delete them.
export function createAppIcons({ getFileIcon, stat, makeProbe, paths = APP_PATHS }) {
  const iconCache = new Map();
  let generic = null;
  const genericDigests = () => (generic ||= (async () => {
    const out = new Set();
    let probe = null;
    try {
      probe = await makeProbe();
      for (const path of [probe.app, probe.missing]) {
        try { const image = await getFileIcon(path, SIZE); if (!image.isEmpty()) out.add(digest(image)); } catch { /* no generic icon from that path */ }
      }
    } catch { /* no probe: nothing counts as generic */ } finally {
      await probe?.remove?.().catch?.(() => {});
    }
    return out;
  })());
  return function appIcon(id) {
    if (iconCache.has(id)) return iconCache.get(id);
    const path = paths[id];
    const reading = (async () => {
      try { await stat(path); } catch { return { app: id, installed: false, icon: null }; }
      try {
        const image = await getFileIcon(path, SIZE);
        if (image.isEmpty() || (await genericDigests()).has(digest(image))) return { app: id, installed: true, icon: null };
        return { app: id, installed: true, icon: image.toDataURL() };
      } catch { return { app: id, installed: true, icon: null }; }
    })();
    iconCache.set(id, reading);
    return reading;
  };
}
