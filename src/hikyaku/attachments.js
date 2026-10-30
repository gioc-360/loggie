// The attachments on an email, listed so nothing is hidden (docs/hikyaku-security.md, step 3). Names, types and sizes
// only: nothing is downloaded or opened here. What a later step will read (PDF and Word up to 20 MB) is marked
// readable; everything else says why it will not be read. Names are checked for the classic disguises.

const MB = 1024 * 1024;
const KINDS = [
  ['macro', /macroEnabled|\.(docm|dotm|xlsm|xltm|pptm|potm|ppsm)$/i],
  ['pdf', /(^application\/pdf$)|\.pdf$/i],
  ['word', /(msword|wordprocessingml)|\.(docx?|rtf|odt|pages)$/i],
  ['sheet', /(spreadsheetml|ms-excel)|\.(xlsx?|csv|numbers|ods)$/i],
  ['slides', /(presentationml|ms-powerpoint)|\.(pptx?|key|odp)$/i],
  ['image', /^image\/|\.(png|jpe?g|gif|heic|webp|tiff?|bmp)$/i],
  ['calendar', /text\/calendar|\.ics$/i],
  ['archive', /(zip|x-7z|x-rar|gzip|x-tar)|\.(zip|7z|rar|gz|tgz|tar)$/i],
  ['program', /\.(exe|msi|dmg|pkg|app|apk|bat|cmd|com|scr|jar|js|vbs|ps1|sh|command|lnk|iso)$/i],
];
const SKIP = {
  sheet: 'spreadsheets are not read yet', slides: 'slides are not read yet', image: 'images are not read',
  calendar: 'a calendar invite: shown as an event, not read', archive: 'archives are never opened',
  macro: 'files that can run macros are never opened',
  program: 'programs and scripts are never opened', other: 'this type is not read',
};
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/;          // for test(): no /g, which would carry state between calls
const BIDI_ALL = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function describeAttachment({ name = '', type = '', size = 0, inline = false, attachmentId = null, messageId = null }) {
  const warnings = [];
  if (BIDI.test(name)) warnings.push('the name hides its real type with invisible characters');
  const clean = name.replace(BIDI_ALL, '');
  const kind = KINDS.find(([, pattern]) => pattern.test(clean) || pattern.test(type))?.[0] || 'other';
  if (/\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|txt)\.(exe|scr|js|vbs|bat|cmd|com|app|jar|ps1|sh|command|lnk)$/i.test(clean)) warnings.push('a double extension: it looks like a document but is a program');
  const sizeKB = Math.round(size / 1024);
  const tooBig = size > 20 * MB;
  const readable = (kind === 'pdf' || kind === 'word') && !tooBig && !warnings.length;
  const skipped = readable ? undefined : warnings.length ? 'never opened: the name is disguised' : tooBig ? 'too large to read (over 20 MB)' : SKIP[kind];
  return { name: clean, type, kind, sizeKB, inline, readable, ...(skipped ? { skipped } : {}), warnings, ...(attachmentId ? { attachmentId, messageId } : {}) };
}

export const describeAttachments = (list = []) => list.map(describeAttachment);

export function attachmentsMarkdown(list) {
  if (!list.length) return [];
  return ['Attachments (hikyaku has not opened them):', ...list.map((file) => `- ${file.name} (${file.kind}, ${file.sizeKB} KB)${file.warnings.length ? `  (warning: ${file.warnings.join('; ')})` : file.skipped ? `  (${file.skipped})` : ''}`), ''];
}

export async function taskAttachments(taskDirectory) {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  return JSON.parse(await readFile(join(taskDirectory, 'ATTACHMENTS.json'), 'utf8').catch(() => '[]'));
}
