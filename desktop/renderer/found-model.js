// The Found step's words (first-run-polish B4.6), pure: what each found row says, the foot button's count, the look's
// progress, and why a look found nothing with its one fix. No DOM, so node tests it. Every field comes from
// hikyaku:found-status (src/hikyaku/found.js); nothing here is new data.
import { dayLabel } from './today-model.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The evidence: what the person wrote about it, or the quote that made it, with who and when.
export function evidenceLine(row = {}) {
  if (Number(row.fromSent) > 0) {
    return `You wrote ${plural(Number(row.fromSent), 'email', 'emails')} about this${row.date ? `, last ${dayLabel(row.date)}` : ''}${row.subject ? ` · ${row.subject}` : ''}`;
  }
  if (row.quote) {
    const quote = row.quote.length > 120 ? `${row.quote.slice(0, 119)}…` : row.quote;
    return `“${quote}”${row.sender ? ` · ${row.sender}` : ''}${row.date ? `, ${dayLabel(row.date)}` : ''}${row.subject ? ` · ${row.subject}` : ''}`;
  }
  return row.subject || '';
}

export function countsLine(row = {}) {
  const threads = Number(row.threads) || 0;
  if (threads <= 0) return '';
  const yours = Number(row.yours) || 0;
  return `${plural(threads, 'thread', 'threads')}${yours > 0 ? ` · ${yours} from you` : ''}`;
}

export function keepLabel(kept, total) {
  if (total === 1) return kept ? 'Keep it and continue' : 'Continue without it';
  if (!kept) return 'Continue without them';
  return kept === total ? `Keep all ${total} and continue` : `Keep ${kept} of ${total} and continue`;
}

export function progressLine(progress) {
  if (!progress) return 'Starting the look…';
  if (progress.naming) return 'Naming what it found…';
  if (!Number(progress.total)) return 'Reading what you wrote…';
  return `Read ${Number(progress.read).toLocaleString('en-US')} of ${Number(progress.total).toLocaleString('en-US')} email threads`;
}

export function progressFraction(progress) {
  if (!progress) return 0;
  if (progress.naming) return 1;
  return Number(progress.total) > 0 ? Number(progress.read) / Number(progress.total) : 0;
}

const CONTINUE = { label: 'Continue', act: 'continue' };
// Why the look found nothing, and the one press that fixes it.
export function zeroCopy(zero = {}) {
  switch (zero?.reason) {
    case 'no-mail':
      return { line: 'Apple Mail has no mail account, so there was nothing to read. In Internet Accounts, add Microsoft Exchange (Outlook, school and work mail) or Google, then open Mail once.',
        button: { label: 'Add an account', act: 'ask' }, links: [{ label: 'Look again', act: 'look' }, CONTINUE] };
    case 'no-yes':
      return { line: 'Loggie reads your mail only after your yes.', button: { label: 'Yes', act: 'yes' }, links: [CONTINUE] };
    case 'no-key':
      return { line: 'Loggie needs your Nebius key to read your mail.', button: { label: 'Add key', act: 'key' }, links: [CONTINUE] };
    case 'none': {
      const read = Number(zero.read) || 0;
      return { line: `No work in your mail looked new and yours.${read ? ` Read ${plural(read, 'email thread', 'email threads')}.` : ''} Loggie looks again every hour.`, button: CONTINUE, links: [] };
    }
    default:
      return { line: `The look stopped: ${zero?.message || 'it did not finish.'}`, button: { label: 'Look again', act: 'look' }, links: [CONTINUE] };
  }
}

// Today's row after Later, while found cards wait for an answer.
export function todayRowText(n) {
  return n === 1 ? 'Loggie found 1 workspace. Keep it if it is yours.' : `Loggie found ${n} workspaces. Keep what is yours.`;
}
