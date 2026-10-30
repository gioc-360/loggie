// "What did Gideon say?" in the ask box (loggie-ask-box increment 6): the newest messages from a chat or an email
// sender, in the card's one shape. Code only: the chat and mail readers run on this Mac and nothing leaves it.
//
//   chatMessages(chat, { limit }) -> [{ from, fromMe, text, at }], oldest first
//   mailMessages(mail, address, { limit }) -> the same, from the person's newest emails (subject and first lines)
export function chatMessages(chat, { limit = 3 } = {}) {
  if (!chat) return [];
  const names = new Map((chat.participants || []).map((person) => [person.handle, person.name]));
  return [...(chat.messages || [])].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))).slice(-limit).map((message) => ({
    from: message.fromMe ? 'You' : names.get(message.from) || message.from || chat.title || 'Them',
    fromMe: Boolean(message.fromMe),
    text: String(message.text || '').trim(),
    at: message.timestamp,
  }));
}

export function mailMessages(mail, address, { limit = 2 } = {}) {
  const wanted = String(address || '').toLowerCase();
  return (mail || []).filter((message) => String(message.from || '').toLowerCase().includes(wanted))
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))).slice(-limit).map((message) => {
      const name = (String(message.from).match(/^\s*"?([^"<]*?)"?\s*</) || [])[1]?.trim() || wanted;
      const first = String(message.snippet || message.body || '').replace(/\s+/g, ' ').trim().slice(0, 220);
      return { from: name, fromMe: false, text: `${message.subject || '(no subject)'}: ${first}`, at: message.timestamp };
    });
}
