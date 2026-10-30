// Turns a recording of the user's real Outlook into a fixture that can be committed to this public repo.
//   node scripts/outlook-eval/redact.mjs IN.json OUT.json --map MAP.json --subject "Thread subject"
// MAP.json is {"real text": "eval text"} (addresses, names, the subject); replaced everywhere, ignoring case,
// longest first. Rows and list entries that are not about the subject become "[other email]"; kept rows lose
// their preview of the email; text inside web content (an email in the reading pane) and attachment names go. A
// text area keeps only its first line and quote-marker lines (From:, Date:, To:, Subject:): the structure the
// decisions read, never the words of anyone's email. Run check-redaction.mjs on the result before committing it.
import { readFile, writeFile } from 'node:fs/promises';

const QUOTE = /^(from|date|sent|to|cc|subject):\s/i;
// An attachment card: "notes.pdf,  0.4 KB". The name goes, the size stays.
const ATTACHMENT = /^(.+\.\w{1,5})(,\s+[\d.]+\s*[KMG]?B)$/;
export function redactText(text, pairs) {
  let out = String(text);
  for (const [real, fake] of pairs) out = out.replace(new RegExp(real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), fake);
  return out;
}
export function keepStructure(value) {
  const lines = String(value).split('\n');
  const first = lines.findIndex((line) => line.trim());
  return lines.map((line, index) => (index === first || QUOTE.test(line.trim()) || !line.trim() ? line : '[redacted line]')).join('\n');
}
// A list row reads "Sender, Subject, time, Folder: X, Has files, <preview of the email>": the preview goes.
export function keepRow(text) {
  return String(text).replace(/(Folder: [^,]+,(\s*Has files,)?).*$/s, '$1');
}
export function redact(json, map, subject) {
  const pairs = Object.entries(map).sort((a, b) => b[0].length - a[0].length);
  const about = (text) => !subject || String(text).toLowerCase().includes(subject.toLowerCase());
  const textOf = (node) => [node.title, node.desc, node.value, ...(node.children || []).map(textOf)].join(' ');
  // Inside web content (an email shown in the reading pane) every text is someone's words: only quote markers stay.
  const webText = (value) => (!value || QUOTE.test(value.trim()) ? redactText(value, pairs) : '[email text]');
  const scrub = (node, other = false, web = false) => {
    if (Array.isArray(node)) return node.map((item) => scrub(item, other, web));
    if (typeof node === 'string') return other ? '[other email]' : redactText(node, pairs);
    if (!node || typeof node !== 'object') return node;
    const isRow = node.role === 'AXRow' || node.role === 'AXCell';
    const hide = other || (isRow && !about(textOf(node)));
    const inWeb = web || node.role === 'AXWebArea';
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (['title', 'desc', 'value'].includes(key) && typeof value === 'string') {
        if (hide && value) out[key] = '[other email]';
        else if (inWeb && node.role !== 'AXTextArea') out[key] = webText(value);
        else out[key] = redactText(node.role === 'AXTextArea' ? keepStructure(value) : isRow ? keepRow(value) : ATTACHMENT.test(value) ? value.replace(ATTACHMENT, '[file]$2') : value, pairs);
      } else if (key === 'rows' && Array.isArray(value)) {
        out.rows = value.map((row) => (about(row) ? redactText(keepRow(row), pairs) : '[other email]'));
      } else if (key === 'path' || key === 'role' || key === 'id') out[key] = value;
      else out[key] = scrub(value, hide && key === 'children', inWeb);
    }
    return out;
  };
  return scrub(json);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [input, output] = process.argv.slice(2);
  const flag = (name) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : null; };
  if (!input || !output || !flag('--map')) { console.error('usage: redact.mjs IN.json OUT.json --map MAP.json [--subject TEXT]'); process.exit(2); }
  const map = JSON.parse(await readFile(flag('--map'), 'utf8'));
  await writeFile(output, `${JSON.stringify(redact(JSON.parse(await readFile(input, 'utf8')), map, flag('--subject')), null, 1)}\n`);
  console.log(`wrote ${output}; now run: node scripts/outlook-eval/check-redaction.mjs`);
}
