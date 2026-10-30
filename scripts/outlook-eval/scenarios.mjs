// The live Outlook scenarios: what the user sends once to set each up, the task hikyaku answers, and what the attempt
// line must show afterwards. Real threads between a mailbox the user controls ("other", e.g. their Gmail) and their
// Outlook account ("self"). Subjects are plain words (HKEVAL S1 ...): Outlook's search reads a hyphen as "not".
// Nothing is ever sent by hikyaku; the user discards each eval reply from Drafts.

export const EVAL_DIR_NAME = 'outlook-eval';
const subjects = {
  S1: 'HKEVAL S1 first reply', S2: 'HKEVAL S2 newest is mine', S3: 'HKEVAL S3 with a cc', S4: 'HKEVAL S4 same subject',
  S5: 'HKEVAL S5 this subject was never sent', S6: 'HKEVAL S6 long thread', S7: 'HKEVAL S7 forwarded note',
};

// a: addresses { other, self, third, otherB }
export function scenarios(a) {
  const base = (id, subject, from, extra = {}) => ({ id, subject, reply: { to: from, subject: `Re: ${subject}`, account: a.self, scenario: id, original: { from, subject }, ...extra } });
  return [
    { ...base('S1', subjects.S1, a.other), title: 'first reply', setup: [`From ${a.other} to ${a.self}: subject "${subjects.S1}", any short text.`], streak: 3 },
    { ...base('S2', subjects.S2, a.other), title: 'second reply, the newest message is your own', streak: 3,
      setup: [`From ${a.other} to ${a.self}: subject "${subjects.S2}".`, `In Outlook, reply to it from ${a.self} and press Send yourself (any text).`] },
    { ...base('S3', subjects.S3, a.other), title: 'a Cc on the email, plain Reply', streak: 2, setup: [`From ${a.other} to ${a.self}, Cc ${a.third}: subject "${subjects.S3}".`] },
    { ...base('S3b', subjects.S3, a.other, { cc: a.third }), title: 'the task asks for a Cc (hikyaku does not fill Cc yet)', expectedFail: true, streak: 1, setup: ['Uses the S3 email.'] },
    { ...base('S4a', subjects.S4, a.other), title: 'same subject from two people: the first', streak: 3,
      setup: [`From ${a.other} to ${a.self}: subject "${subjects.S4}".`, `Then from ${a.otherB} to ${a.self}: the same subject "${subjects.S4}".`] },
    { ...base('S4b', subjects.S4, a.otherB), title: 'same subject from two people: the second', streak: 3, setup: ['Uses the two S4 emails.'] },
    { ...base('S5', subjects.S5, a.other), title: 'the email cannot be found', streak: 2, setup: ['Nothing to send: this subject must exist nowhere.'] },
    { ...base('S6', subjects.S6, a.other), title: 'a long thread (more than 8 messages)', streak: 2, optional: true,
      setup: [`Ten messages on subject "${subjects.S6}", alternating: ${a.other} writes, you reply from Outlook, five times each, ending with one from ${a.other}.`] },
    { ...base('S7', `Fwd: ${subjects.S7}`, a.other), title: 'a forwarded email', streak: 3,
      setup: [`From ${a.third} to ${a.other}: subject "${subjects.S7}".`, `In ${a.other}, forward it to ${a.self} (the subject becomes "Fwd: ${subjects.S7}").`] },
    { ...base('S8', subjects.S1, a.other), title: 'a reply already open', streak: 2, setup: ['Uses the S1 email. Before the run, open a reply on it in Outlook by hand and leave it open.'] },
  ];
}

const has = (list = [], address) => list.some((token) => token.includes(address.toLowerCase()));
// Problems with one attempt line, for one scenario. An empty list is a pass.
export function judge(s, line, a) {
  const p = [];
  const audit = line.audit || {};
  const opened = (audit.to_fields_after ?? 0) - (audit.to_fields_before ?? 0);
  if (!line.helperSha) p.push('the attempt has no helperSha: it ran an old helper');
  if (s.id === 'S5') {
    if (line.mode !== 'not-found') p.push(`mode is ${line.mode}, expected not-found`);
    if (line.status !== 'no-match') p.push(`status is ${line.status}, expected no-match`);
    if (line.pasted === true || opened > 0) p.push('a reply was opened for an email that does not exist');
    return p;
  }
  if (s.id === 'S3b') {
    if (line.status !== 'audit-cc-missing' || line.pasted !== true) p.push(`expected the draft pasted with audit-cc-missing, got ${line.status}`);
    return p;
  }
  if (line.status !== 'replied') p.push(`status is ${line.status}${line.findings?.length ? ` (${line.findings.join(', ')})` : ''}, expected replied`);
  if (line.findings?.length) p.push(`findings: ${line.findings.join(', ')}`);
  const want = s.reply.to.toLowerCase();
  const to = audit.to_tokens || [];
  if (to.length !== 1 || !has(to, want)) p.push(`To is [${to.join(' | ')}], expected only ${want}`);
  if ((audit.cc_tokens || []).length) p.push(`Cc is [${audit.cc_tokens.join(' | ')}], expected empty`);
  if (audit.own_in_recipients) p.push('your own address is on the reply');
  if (opened !== 1) p.push(`${opened} reply windows opened, expected 1`);
  if (audit.draft_count !== 1) p.push(`the draft appears ${audit.draft_count ?? 0} times`);
  if ((audit.signature_count ?? 0) > 1) p.push(`the signature appears ${audit.signature_count} times`);
  const on = line.replied_on || {};
  if (s.id === 'S2') {
    if (on.own !== true) p.push('replied on the person\'s email; expected your own newer note, with Reply all');
    if ((line.candidates_checked ?? 0) < 2) p.push(`checked ${line.candidates_checked} rows, expected at least 2`);
  } else if (!String(on.from || '').includes(want)) p.push(`replied on a message from ${on.from || 'nobody'}, expected ${want}`);
  // S4: Outlook groups the two same-subject emails into one conversation, so both rows can show the right sender's
  // header (seen live 2026-10-05). What must hold is who the reply is on and to, checked above.
  if ((s.id === 'S4a' || s.id === 'S4b') && (line.candidates_total ?? 0) < 2) p.push(`${line.candidates_total} rows found, expected both same-subject emails`);
  if (s.id === 'S7' && a.third && has(to, a.third)) p.push('the reply went to the original author, not the forwarder');
  if (s.id === 'S8' && (audit.to_fields_before ?? 0) < 1) p.push('no reply was open before the run; open one by hand first');
  if (s.id === 'S6' && (line.candidates_total ?? 0) <= 8) p.push(`only ${line.candidates_total} rows found; the thread needs more than 8 messages`);
  return p;
}
