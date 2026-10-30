// Tavily web search (loggie-search-check): the one place hikyaku asks the web. Used by the name check, after the
// user's yes on the call, for words already judged to be companies, products or places, never people; and by the errand
// and the draft's fact check (look-outside.js), which also read the top pages with extract. The key lives in
// the keychain (service "tavily", account "hikyaku"); it is read per search and never logged.

import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

export const TAVILY_URL = 'https://api.tavily.com/search';
export const TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract';
export const USAGE_FILE = 'tavily-usage.jsonl';
export const KEYCHAIN = Object.freeze({ service: 'tavily', account: 'hikyaku' });
export const TIMEOUT_MS = 20000;
export const PAGE_CHARS = 4000;

export function tavilyKey({ execFileImpl = execFile } = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-w'], { timeout: 10000 }, (error, stdout) => {
      const key = String(stdout || '').trim();
      if (error || !key) reject(new Error('No Tavily key in the keychain (service "tavily", account "hikyaku"). Names were not checked on the web.'));
      else resolve(key);
    });
  });
}

// search(query, options) -> [{ title, url, content, score, published }] (at most `max`, or options.max_results). Throws on
// a missing key or a failed call; the caller keeps the word as it was.
// The options follow Tavily's own search guide (docs.tavily.com, best-practices-search, read 2026-10-15): topic "news"
// with a time_range for what is new, search_depth "advanced" for a niche or many-sided question (2 credits),
// include_domains with mode "prefer" to favor an official site without hiding the rest of the web. With no options the
// body is the name check's own, { query, max_results }.
const SEARCH_OPTIONS = ['topic', 'time_range', 'search_depth', 'include_domains', 'include_domains_mode'];
export const searchCredits = (options = {}) => (options?.search_depth === 'advanced' ? 2 : 1);
export function createTavily({ home = null, keyImpl = tavilyKey, fetchImpl = globalThis.fetch, max = 3, timeoutMs = TIMEOUT_MS } = {}) {
  return async function search(query, options = {}) {
    const limit = Number.isInteger(options?.max_results) && options.max_results > 0 ? Math.min(options.max_results, 10) : max;
    const extra = Object.fromEntries(SEARCH_OPTIONS.filter((name) => options?.[name] != null).map((name) => [name, options[name]]));
    const key = await keyImpl();
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
    let response;
    try {
      response = await fetchImpl(TAVILY_URL, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, max_results: limit, ...extra }), signal });
    } catch (error) { throw new Error(`Tavily could not be reached (${error?.name || 'network error'}).`); }
    if (!response.ok) throw new Error(`Tavily answered ${response.status}.`);
    const body = await response.json();
    return (Array.isArray(body?.results) ? body.results : []).slice(0, limit).map((r) => ({ title: String(r.title || ''), url: String(r.url || ''),
      content: String(r.content || '').slice(0, 600), score: Number(r.score) || 0, published: r.published_date ? String(r.published_date) : null }));
  };
}

// extract(urls, query) -> [{ url, content }] (loggie-errand): the pages' text closest to the query, cut to 4,000
// characters each (1,500 left the judge a sliver of the page; raised 2026-10-15), one item per page Tavily could read. `timeout` in the body is Tavily's own, in seconds; our abort
// waits longer on purpose. Throws on a missing key or a failed call; the caller then has no page to quote.
export function createTavilyExtract({ keyImpl = tavilyKey, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  return async function extract(urls, query) {
    const key = await keyImpl();
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
    let response;
    try {
      response = await fetchImpl(TAVILY_EXTRACT_URL, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ urls, query, chunks_per_source: 3, extract_depth: 'basic', format: 'text', timeout: 15 }), signal });
    } catch (error) { throw new Error(`Tavily could not be reached (${error?.name || 'network error'}).`); }
    if (!response.ok) throw new Error(`Tavily answered ${response.status}.`);
    const body = await response.json();
    return (Array.isArray(body?.results) ? body.results : [])
      .filter((r) => typeof r?.raw_content === 'string' && r.raw_content)
      .map((r) => ({ url: String(r.url || ''), content: r.raw_content.slice(0, PAGE_CHARS) }));
  };
}

// Test key on the setup page (teammate-ready B5.2): one search for "Loggie" through `search` (createTavily), logged as
// path test-key. The answer is one plain sentence and never holds the key. With no key nothing
// is sent, so nothing is logged.
export async function testTavilyKey({ search, home = null }) {
  try {
    await search('Loggie');
  } catch (error) {
    const said = String(error?.message || '');
    if (/^No Tavily key/.test(said)) return { ok: false, message: 'There is no key yet. Paste it first.' };
    await logTavily(home, { path: 'test-key', kind: 'search', credits: 0, ok: false });
    if (/^Tavily answered (401|403)\b/.test(said)) return { ok: false, message: 'Tavily did not accept this key.' };
    if (/could not be reached/.test(said)) return { ok: false, message: 'Loggie could not reach Tavily. Check your connection and try again.' };
    return { ok: false, message: 'The test did not work. Check the key and try again.' };
  }
  await logTavily(home, { path: 'test-key', kind: 'search', credits: searchCredits(), ok: true });
  return { ok: true, message: 'The key works.' };
}

// One line per Tavily request in <home>/tavily-usage.jsonl, with what it cost: a search that answered 1 credit, an
// extract that read a page 1 credit, anything that failed 0. Never throws.
export async function logTavily(home, { path, kind, credits, ok }) {
  if (!home) return;
  try { await appendFile(join(home, USAGE_FILE), `${JSON.stringify({ at: new Date().toISOString(), path, kind, credits, ok })}\n`); } catch { /* the log never stops a check */ }
}
