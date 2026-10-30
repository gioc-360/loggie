// Nemotron Super on Nebius Token Factory (spec-entry-b.md B5, B7): the one transport a next move uses to cross the
// line. OpenAI-compatible POST /chat/completions, no tools. The key is read from the keychain inside post(), at the
// moment of the request, and held in memory only: never in a file, an event, a receipt or an error message. The
// reply's reasoning fields are dropped here, so nothing downstream can keep them. Nothing here decides what may be
// sent: next-move.js builds and gates the request, and calls post() only after the gate and the receipt.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HIKYAKU_HOME } from './draft.js';
import { recordUsage } from './usage.js';

export const NEBIUS_BASE = 'https://api.tokenfactory.nebius.com/v1';
export const NEBIUS_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
// The bigger model: call notes (byo.py NEBIUS_TEAM_MODEL) and the name check (2026-10-12: on 3 real calls it searched no
// person where Super sorted one as a company, and called 1 word a person where Super called 4; 0.4 cents more a call).
export const NEBIUS_ULTRA = 'nvidia/Nemotron-3-Ultra-550b-a55b';
export const PROVIDER_ID = 'nebius-token-factory';
export const KEYCHAIN = Object.freeze({ service: 'nebius-token-factory', account: 'hikyaku' });
const TIMEOUT_MS = 15 * 60 * 1000;

// The key, from the keychain (`security ... -w`). A missing key is a refusal that says where the key belongs; it
// never repeats security's own output, which can echo what was asked.
export function keychainKey({ execFileImpl = execFile } = {}) {
  const envKey = process.env.NEBIUS_API_KEY ? process.env.NEBIUS_API_KEY.trim() : '';
  if (envKey) return Promise.resolve(envKey);
  return new Promise((resolve, reject) => {
    execFileImpl('security', ['find-generic-password', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-w'], { timeout: 30000 }, (error, stdout) => {
      const key = error ? '' : String(stdout || '').trim();
      if (!key) reject(new Error(`No cloud key in the keychain (service "${KEYCHAIN.service}", account "${KEYCHAIN.account}"). Add it there, then press Send again. Nothing was sent.`));
      else resolve(key);
    });
  });
}

const scrub = (text, key) => String(text).split(key || '\u0000').join('[key]').replace(/Bearer\s+\S+/gi, 'Bearer [hidden]');

// complete: post(bodyText) -> { content, finish_reason, model, usage, seconds, copies }. bodyText is the exact request
// (next-move.js hashes it for the receipt), sent as is. An HTTP error or a dead network throws with plain words and
// the status only, never the body, which can echo the header.
//
// A second copy after hedgeMs. Of 34 next moves on 2026-10-08, 30 answered in 1.4-3.9 s and 4 took 31.6, 55.9, 56.8
// and 91.9 s with prompts the same size, so the slow ones were Token Factory's queue, not the request. When the
// first copy has not answered after hedgeMs (6 s, past every normal answer), the same bytes go once more and the
// first good answer wins; the other is cancelled. Both copies are the request the user approved, to the provider
// the user picked, and `copies` says how many went, so the receipt can say it. A copy that fails fast (an HTTP
// error before hedgeMs) fails the call as before: a backup copy is for a slow queue, not a refusal.
export const HEDGE_MS = 6000;
class HttpStatus extends Error { constructor(status) { super(`The cloud AI answered with an error (HTTP ${status}). Nothing was written.`); this.status = status; } }

// Every answer that comes back is logged with its tokens and cost (usage.js), whether it is kept or not: an answer cut
// at the token limit is billed too. Only a real network call is logged; a test's fake fetch costs nothing.
// Paid once: an answer that finished (finish_reason stop, some text) is saved under the hash of what was asked, and
// the same request again is answered from it for $0 (a usage row with cached: true). Every request is temperature 0,
// so the saved answer is the one the service would give. A leading "Request <hex>." line, which byo.py adds to dodge
// Nebius's own prompt cache, is not part of the key. Saved answers stay in <home>/nebius-answers/ on this Mac.
export const ANSWERS_DIR = 'nebius-answers';
const NONCE = /^Request [0-9a-f]+\.\n\n/;
export function answerKey(bodyText) {
  let body;
  try { body = JSON.parse(bodyText); } catch { return null; }
  const messages = (body.messages || []).map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content.replace(NONCE, '') : m.content }));
  const asked = { model: body.model, messages, max_tokens: body.max_tokens, temperature: body.temperature, chat_template_kwargs: body.chat_template_kwargs };
  return createHash('sha256').update(JSON.stringify(asked)).digest('hex');
}
async function savedAnswer(home, key) {
  if (!home || !key) return null;
  return JSON.parse(await readFile(join(home, ANSWERS_DIR, `${key}.json`), 'utf8').catch(() => 'null'));
}
async function saveAnswer(home, key, answer) {
  if (!home || !key || answer.finish_reason !== 'stop' || !answer.content) return;
  await mkdir(join(home, ANSWERS_DIR), { recursive: true });
  await writeFile(join(home, ANSWERS_DIR, `${key}.json`), `${JSON.stringify({ at: new Date().toISOString(), ...answer })}\n`);
}

export function createTokenFactory({ baseUrl = NEBIUS_BASE, keyImpl = keychainKey, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, hedgeMs = HEDGE_MS, usageHome = fetchImpl === globalThis.fetch ? HIKYAKU_HOME : null, answersHome = usageHome } = {}) {
  const url = `${baseUrl}/chat/completions`;
  return {
    url,
    async post(bodyText, { path = 'other', fresh = false } = {}) {
      const key = fresh ? null : answerKey(bodyText);
      const saved = await savedAnswer(answersHome, key);
      if (saved) {
        if (usageHome) await recordUsage(usageHome, { path, model: saved.model, usage: saved.usage || {}, seconds: 0, finishReason: saved.finish_reason, cached: true }).catch((error) => console.error(`cloud AI usage not logged: ${error.message}`));
        return { content: saved.content, finish_reason: saved.finish_reason, model: saved.model, usage: saved.usage || {}, seconds: 0, copies: 0, cached: true };
      }
      const t0 = Date.now();
      let copies = 1;
      let text;
      const apiKey = await keyImpl();
      const controllers = [];
      const send = async () => {
        const controller = new AbortController();
        controllers.push(controller);
        const signals = [controller.signal, ...(typeof AbortSignal?.timeout === 'function' ? [AbortSignal.timeout(timeoutMs)] : [])];
        const signal = typeof AbortSignal?.any === 'function' ? AbortSignal.any(signals) : controller.signal;
        let response;
        try {
          response = await fetchImpl(url, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: bodyText, signal });
        } catch (error) {
          throw new Error(`The cloud AI could not be reached (${scrub(error?.name || 'network error', apiKey)}). Nothing was written.`);
        }
        if (!response.ok) throw new HttpStatus(response.status);
        return response.text();
      };
      let timer = null;
      try {
        text = await new Promise((resolve, reject) => {
          let open = 1;
          let firstError = null;
          const race = (promise) => promise.then(resolve, (error) => { firstError ??= error; open -= 1; if (open === 0) reject(firstError); });
          race(send());
          // A copy that fails before the backup is due leaves nothing open, so the call fails as one request always did.
          if (hedgeMs > 0) timer = setTimeout(() => { copies = 2; open += 1; race(send()); }, hedgeMs);
        });
      } finally {
        clearTimeout(timer);
        for (const controller of controllers) controller.abort();
      }
      const seconds = Math.round((Date.now() - t0) / 100) / 10;
      let result;
      try { result = JSON.parse(text); } catch { throw new Error('The cloud AI did not answer in JSON. Nothing was written.'); }
      const choice = (Array.isArray(result?.choices) && result.choices[0]) || {};
      const message = choice.message || {};
      // `copies`: a backup copy went too (hedgeMs); the line is the answer that won, the copy count says a second was sent.
      if (usageHome) await recordUsage(usageHome, { path, model: String(result?.model || ''), usage: result?.usage || {}, seconds, finishReason: choice.finish_reason ?? null, copies }).catch((error) => console.error(`cloud AI usage not logged: ${error.message}`));
      const answer = {
        content: typeof message.content === 'string' ? message.content.trim() : '',
        finish_reason: choice.finish_reason ?? null,
        model: String(result?.model || ''),
        usage: result?.usage || {},
        seconds,
        copies,
      };
      await saveAnswer(answersHome, key, answer).catch((error) => console.error(`cloud AI answer not saved: ${error.message}`));
      return answer;
    },
  };
}

// Test key (C6): one tiny request with fixed words and none of the user's text, made only when the user presses it. The errors the client throws carry a status and no body.
export async function testCloudKey({ client = createTokenFactory() } = {}) {
  try {
    await client.post(JSON.stringify({ model: NEBIUS_MODEL, messages: [{ role: 'user', content: 'Reply with ok.' }], max_tokens: 4, temperature: 0 }), { path: 'test-key', fresh: true });
    return { ok: true, message: 'The key works.' };
  } catch (error) {
    const said = String(error?.message || '');
    if (/No cloud key/.test(said)) return { ok: false, message: 'There is no key yet. Save a key first.' };
    if (/HTTP (401|403)/.test(said)) return { ok: false, message: 'The cloud AI did not accept this key.' };
    if (/could not be reached/.test(said)) return { ok: false, message: 'Loggie could not reach the cloud AI. Check your connection and try again.' };
    return { ok: false, message: 'The test did not work. Check the key and try again.' };
  }
}
