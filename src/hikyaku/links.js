// Links in an email, made readable and safe to show: the real destination domain, wrappers like Outlook Safe Links
// unwrapped (so they do not look like a mismatch), and a warning when something looks off. Nothing here opens a link
// or makes any network request (docs/hikyaku-security.md, rule 1); the user clicks links in their own browser.

const TWO_PART_SUFFIXES = new Set(['co.uk', 'ac.uk', 'org.uk', 'gov.uk', 'co.jp', 'ne.jp', 'ac.jp', 'com.au', 'edu.au', 'co.nz', 'com.br', 'co.in', 'com.cn', 'com.mx', 'co.kr']);
const SHORTENERS = new Set(['bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly', 'lnkd.in', 'shorturl.at']);
// Mail services that route every click through their own server first. Ordinary newsletters do this, so a link
// that goes through one is noted as tracked, not warned about: a warning on every newsletter teaches people to ignore
// warnings (150 real emails, 2026-10-04: 56 of 714 links would have warned, nearly all tracking).
const TRACKERS = new Set(['awstrack.me', 'list-manage.com', 'sendgrid.net', 'mandrillapp.com', 'hubspotlinks.com', 'exct.net', 'rs6.net', 'mailgun.org', 'sparkpostmail.com', 'mcsv.net', 'mlsend.com', 'cmail19.com', 'cmail20.com', 'createsend.com', 'mailchimp.com', 'icptrack.com', 'ct.sendgrid.net', 'linkedin.com', 'campaign-archive.com']);
const FILE_TYPES = new Set(['docx', 'doc', 'pdf', 'xlsx', 'xls', 'pptx', 'ppt', 'png', 'jpg', 'jpeg', 'gif', 'zip', 'csv', 'txt', 'md', 'mp4', 'mov', 'ics', 'heic']);

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };

// The part of a host a person owns: "nam12.safelinks.protection.outlook.com" -> "outlook.com", "x.ac.uk" -> "x.ac.uk".
export function registrable(host = '') {
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  return TWO_PART_SUFFIXES.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

// Security gateways rewrite links; show where they really go.
export function unwrap(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host.endsWith('safelinks.protection.outlook.com') && parsed.searchParams.get('url')) return { url: parsed.searchParams.get('url'), wrapped: 'Microsoft Safe Links' };
    if ((host === 'www.google.com' || host === 'google.com') && parsed.pathname === '/url' && (parsed.searchParams.get('q') || parsed.searchParams.get('url'))) return { url: parsed.searchParams.get('q') || parsed.searchParams.get('url'), wrapped: 'Google redirect' };
    // Proofpoint URL Defense (Cornell's gateway). v3: the real address sits between "__" markers; v2: in u=, with
    // "-XX" hex escapes and "_" for "/".
    if (host === 'urldefense.com' || host === 'urldefense.proofpoint.com') {
      const v3 = url.match(/\/v3\/__(.+?)__;/);
      if (v3) return { url: v3[1], wrapped: 'Proofpoint URL Defense' };
      const u = parsed.searchParams.get('u');
      if (u) return { url: u.replace(/_/g, '/').replace(/-([0-9A-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16))), wrapped: 'Proofpoint URL Defense' };
    }
  } catch { /* not a URL */ }
  return { url, wrapped: null };
}

const DOMAIN_IN_TEXT = /^(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#]\S*)?$/i;

// Two levels. A warning (red) when a link pretends to be a site the user trusts (their own address's domain, their
// workstreams' domains) but goes elsewhere, or uses a bare IP or lookalike characters: that is how phishing works, and
// phishing usually comes from the attacker's own domain, so "goes through the sender's site" is never an excuse. A
// note (gray) for every other link whose text and destination differ (mail services, opaque redirects such as
// campus newsletters): hikyaku cannot see past them without opening them, and it never opens them.
export function analyzeLink({ text = '', href }, { trusted = [] } = {}) {
  const { url, wrapped } = unwrap(href);
  const host = hostOf(url);
  const warnings = [];
  const candidate = text.trim().match(DOMAIN_IN_TEXT)?.[1]?.toLowerCase().replace(/^www\./, '') || '';
  const shown = FILE_TYPES.has(candidate.split('.').at(-1)) ? '' : candidate;   // "15500.docx" is a file name, not a site
  const trust = new Set(trusted.map((domain) => registrable(String(domain).toLowerCase())));
  const differs = Boolean(shown && host && registrable(shown) !== registrable(host));
  const throughTracker = Boolean(host && (TRACKERS.has(registrable(host)) || TRACKERS.has(host)));
  const mismatch = differs && trust.has(registrable(shown));
  if (mismatch) warnings.push(`pretends to be ${shown}, a site you trust, but goes to ${host}`);
  const note = differs && !mismatch ? `shows ${shown}, but goes through ${host} first` : throughTracker ? `goes through ${host} first` : '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) warnings.push('goes to a bare IP address, not a named site');
  if (host.split('.').some((label) => label.startsWith('xn--'))) warnings.push('the address uses lookalike characters');
  if (SHORTENERS.has(host)) warnings.push('a shortened link hides where it goes');
  if (!host) warnings.push('not a readable address');
  return { text: text.trim(), url, domain: host, ...(wrapped ? { wrapped } : {}), ...(note ? { note } : {}), mismatch, warnings };
}

export function analyzeLinks(rawLinks = [], { trusted = [] } = {}) {
  const seen = new Set();
  return rawLinks.map((link) => analyzeLink(link, { trusted })).filter((link) => link.url && !seen.has(link.url) && seen.add(link.url));
}

export function linksMarkdown(links) {
  if (!links.length) return [];
  return ['Links in this email (hikyaku never opens them):', ...links.map((link) => `- ${link.text ? `${link.text} -> ` : ''}${link.domain || link.url}${link.warnings.length ? `  (warning: ${link.warnings.join('; ')})` : link.note ? `  (${link.note})` : ''}`), ''];
}

// The links saved for a task, for the screen. Missing file: no links.
export async function taskLinks(taskDirectory) {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  return JSON.parse(await readFile(join(taskDirectory, 'LINKS.json'), 'utf8').catch(() => '[]'));
}

// Links as written in an email, and the HTML-to-text they need, moved here from the Gmail sign-in's mime.js when it was
// dropped (2026-10-28, teammates' mail fix 5): Apple Mail's reader (apple-mail-entry.js) still collects them.
function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x?[\da-f]+|\w+);/gi, (_match, entity) => {
    if (entity[0] === '#') {
      const hexadecimal = entity[1]?.toLowerCase() === 'x';
      const point = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : '';
    }
    return named[entity.toLowerCase()] ?? '';
  });
}

export function htmlToSafeText(html = '') {
  return decodeEntities(html
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Links as the sender wrote them: visible text and address, from the HTML (whose addresses htmlToSafeText drops)
// and bare addresses in the plain text. Only collected, never fetched.
export function extractRawLinks(html = '', plain = '') {
  const links = [];
  for (const match of String(html).matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeEntities(match[2]).trim();
    if (/^https?:\/\//i.test(href)) links.push({ text: htmlToSafeText(match[3]).replace(/\s+/g, ' ').trim(), href });
  }
  for (const match of String(plain).matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) links.push({ text: '', href: match[0].replace(/[.,;:!?]+$/, '') });
  const seen = new Set();
  return links.filter((link) => !seen.has(link.href) && seen.add(link.href)).slice(0, 30);
}

