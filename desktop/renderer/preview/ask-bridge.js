// The ask box's stand-in for the ask check (ask-check.cjs): the real panel, with the ask bridge answered by the real
// readers over HTTP (the check's server runs createAsker in Node on made-up people). Loads after panel-bridge.js.
const base = window.loggie;
const done = [];
const drafts = [];
const record = (call) => { window.__calls = (window.__calls || []).concat(call); };
const ask = {
  preview: async (text) => ({ ok: true, data: await (await fetch(`/ask-preview?text=${encodeURIComponent(text)}`)).json() }),
  // a run ends with a placed draft, as main's onDone would, so the box is free again; an email first sends its draft
  // (as main's ask:draft does) and finishes 600 ms later, so the check can read the card while Outlook would work
  run: async (text, choices = {}) => {
    record(`ask.run ${text}`);
    if (Object.keys(choices).length) record(`ask.choices ${JSON.stringify(choices)}`);
    const email = /^email /.test(text);
    if (email) {
      const shown = (await (await fetch(`/ask-preview?text=${encodeURIComponent(text)}`)).json()).thread;
      const thread = [shown, ...(shown?.others || [])].find((t) => t?.id === choices['@thread']) || shown;
      setTimeout(() => drafts.forEach((listener) => listener({ askId: 'ask-check-1', to: 'Lena Ortiz', app: 'outlook', thread: choices['@thread'] === 'new' ? null : thread, subject: '', body: 'Hi Lena,\n\nSending my notes.\n\nGio', how: 'ai' })), 30);
    }
    setTimeout(() => done.forEach((listener) => listener({ askId: 'ask-check-1', outcome: 'placed', results: [], words: '' })), email ? 600 : 50);
    return { ok: true, data: { askId: 'ask-check-1' } };
  },
  stop: async () => ({ ok: true, data: true }),
  undo: async () => ({ ok: true, data: { lines: [] } }),
  onStep: () => () => {},
  onDone: (listener) => { done.push(listener); return () => {}; },
  onDraft: (listener) => { drafts.push(listener); return () => {}; },
};
window.loggie = new Proxy(base, { get: (target, key) => (key === 'ask' ? ask : target[key]) });
