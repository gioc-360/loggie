// A question Loggie stopped on, split for the Needs-you card (docs/archive/tasks-space/proposal.md): the words a person reads
// (a helper's command line taken out) and the answers the question names ('Answer "again" ... or "new"'), which the
// card offers as buttons. Pure, so the tests need no DOM.

const COMMAND = /Command failed:[\s\S]*?(?=The draft|Answer "|$)/;

export function askParts(question) {
  const text = String(question || '');
  const plain = text.replace(COMMAND, '').replace(/\s+/g, ' ').trim();
  const at = plain.lastIndexOf('Answer "');
  const options = at < 0 ? [] : [...plain.slice(at).matchAll(/"([^"]{1,30})"/g)].map((m) => m[1]);
  return { plain, options: [...new Set(options)], hadCommand: COMMAND.test(text) };
}
