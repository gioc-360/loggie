// The one router for every language-model call: Nemotron on Nebius Token Factory, the same client next moves use.
// There is no model on this Mac (Gio, 2026-10-18); an old settings.json "thinker": "local" is ignored.
// The cloud path takes only text that forCloud() wrapped, so a plain string can never cross the line by accident.
// The five raw-mail paths get their `complete` from cloud-screen.js thinkWith, which screens every prompt on this Mac
// and names the yes it runs under; nothing else may call forCloud (its source scan).
import { NEBIUS_MODEL, NEBIUS_ULTRA, createTokenFactory } from './nebius.js';
import { randomBytes } from 'node:crypto';

export const DEFAULT_THINKER = 'cloud';
const BRAND = Symbol('screened-for-cloud');
const NOT_SCREENED = 'Loggie stopped this: the text was not screened on this Mac, so it was not sent.';

// The only way to make cloud input. screenedBy names the screen that ran, consent names the yes that allows the send.
export function forCloud(text, { screenedBy, consent } = {}) {
  if (!screenedBy) throw new Error('Loggie stopped this: no screen is named for this text, so it was not sent.');
  if (!consent) throw new Error('Loggie stopped this: no yes is recorded for this text, so it was not sent.');
  const input = { text: String(text) };
  Object.defineProperty(input, BRAND, { value: true, enumerable: false });
  return input;
}

// `model` picks the cloud model (Super unless a path asks for Ultra). Ultra's prompt gets a fresh first line: Nebius's
// prompt cache breaks it (byo.py, 2026-10-08), so no request may start with a prefix it has seen.
export function createThinker({ nebiusClient = null, label = 'other', model = NEBIUS_MODEL } = {}) {
  const where = DEFAULT_THINKER;
  let client = nebiusClient;
  async function complete(input, { maxTokens } = {}) {
    if (!input || input[BRAND] !== true) throw new Error(NOT_SCREENED);
    client ||= createTokenFactory();
    const content = model === NEBIUS_ULTRA ? `Request ${randomBytes(4).toString('hex')}.\n\n${input.text}` : input.text;
    const body = JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: maxTokens ?? 600, temperature: 0, chat_template_kwargs: { enable_thinking: false } });
    const reply = await client.post(body, { path: label });
    if (!reply.content && reply.finish_reason === 'length') throw new Error(`The cloud AI ran out of room (${maxTokens ?? 600} tokens) before answering.`);
    return reply.content;
  }
  return { where, complete };
}
