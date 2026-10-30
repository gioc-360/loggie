// Signs the screens share, drawn as SVG so they take the text color in both themes, and the user's calendar day.
// Today, Workspaces and Notes & Meetings draw the same marks for the same things.
export const localToday = (now = new Date()) => now.toLocaleDateString('en-CA');
export const APP_ICON = { outlook: 'mail', gmail: 'mail', 'apple-mail': 'mail', messages: 'chat', whatsapp: 'wa' };
const ICONS = {
  mail: ['M3 5.5h18v13H3z', 'M3.5 7l8.5 6 8.5-6'],
  chat: ['M4 5.5h16v10H10l-4.5 3.5V15.5H4z'],
  wa: ['M12 3.5a8.5 8.5 0 0 0-7.4 12.7L3.5 20.5l4.4-1.1A8.5 8.5 0 1 0 12 3.5z', 'M9 9.5c.3 2.3 2.2 4.2 4.5 4.5l1-1.2 1.8.9'],
  up: ['M12 19V5', 'M6 11l6-6 6 6'],
  down: ['M12 5v14', 'M6 13l6 6 6-6'],
  refresh: ['M19 12a7 7 0 1 1-2.05-4.95', 'M19.5 4.5V9H15'],
  pencil: ['M4.5 19.5l1-4.5 10-10 3.5 3.5-10 10z', 'M13.5 7l3.5 3.5'],
  archive: ['M4 5h16v4H4z', 'M5.5 9v10h13V9', 'M10 13h4'],
  trash: ['M5 7h14', 'M9.5 7V4.5h5V7', 'M7 7l1 13h8l1-13'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  pause: ['M9 6v12', 'M15 6v12'],
  fusen: ['M7.5 3.5h9v17h-9z', 'M7.5 14.5h9'],
  copy: ['M9 9h10.5v10.5H9z', 'M15 9V4.5H4.5V15H9'],
  share: ['M12 3.5v11', 'M8 7.5l4-4 4 4', 'M7 11H5.5v9.5h13V11H17'],
  play: ['M8.5 5.5l10 6.5-10 6.5z'],
  cal: ['M4 5.5h16v14H4z', 'M4 10h16', 'M8.5 3.5v4', 'M15.5 3.5v4'],
  x: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
  clock: ['M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17z', 'M12 7.5V12l3 2'],
  ring: ['M12 3.5a8.5 8.5 0 1 1-8.5 8.5'],
  phone: ['M6.5 3.5h3l1.5 4.5-2 1.5a11 11 0 0 0 5.5 5.5l1.5-2 4.5 1.5v3a2 2 0 0 1-2 2A16.5 16.5 0 0 1 4.5 5.5a2 2 0 0 1 2-2z'],
  look: ['M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13z', 'M15.3 15.3L20 20'],
  dots: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  back: ['M15 5l-7 7 7 7'],
  // Reply on a To do move (today-model.js canReplyTo): the arrow back to the person.
  reply: ['M9.5 7.5L4.5 12l5 4.5', 'M5 12h9a5.5 5.5 0 0 1 5.5 5.5V19'],
  // The ask bar's mic (panel.html), as paths: the Voice step's mark.
  mic: ['M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z', 'M5 10v2a7 7 0 0 0 14 0v-2', 'M12 19v3', 'M8 22h8'],
  // The header's brand mark (panel.html), on Today's Draft it.
  loggie: ['M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0l1.58 6.14a2 2 0 0 0 1.44 1.44l6.13 1.58a.5.5 0 0 1 0 .96l-6.13 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z', 'M20 3v4M22 5h-4M4 17v2M5 18H3'],
};
export function icon(name, className = '') {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `ws-icon${className ? ` ${className}` : ''}`);
  for (const d of ICONS[name] || []) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
