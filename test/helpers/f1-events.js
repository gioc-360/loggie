// Fixture F1 (docs/availability/spec.md section 3): the made-up Friday both availability tests read. Each event is on
// Exchange and again on iCloud/Work unless marked, as a real synced calendar shows it.
export const ev = (start, end, extra = {}) => ({ start, end, allDay: false, writable: true, attendees: [], calendar: 'Calendar', account: 'Exchange', ...extra });
export const both = (start, end, extra = {}) => [ev(start, end, extra), ev(start, end, { ...extra, account: 'iCloud', calendar: 'Work' })];
export const F1_EVENTS = [
  ...both('2026-10-23T15:15:00Z', '2026-10-23T16:30:00Z', { title: 'Strategy class' }),
  ev('2026-10-23T17:00:00Z', '2026-10-23T19:00:00Z', { account: 'iCloud', calendar: 'Work', title: 'Hold for prep' }),
  ...both('2026-10-23T19:15:00Z', '2026-10-23T20:45:00Z', { title: 'Finance section' }),
  ev('2026-10-23T20:30:00Z', '2026-10-23T20:55:00Z', { attendees: ['person@example.com'], title: 'Coffee chat' }),
  ...both('2026-10-23T21:00:00Z', '2026-10-23T21:30:00Z', { title: 'Club meeting' }),
  ...both('2026-10-24T00:00:00Z', '2026-10-24T01:00:00Z', { title: 'Dinner' }),
];
