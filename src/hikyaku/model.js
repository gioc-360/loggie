// Reading a model's JSON answer: the first {...} in the reply, thinking tags dropped. Every model call is Nemotron on
// Nebius (thinker.js); there is no model on this Mac (Gio, 2026-10-18: "fully remove nemotron on mac").

export function parseJsonReply(raw) {
  const text = String(raw).replace(/<think>[\s\S]*?<\/think>/g, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const asObject = (json) => {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  };
  try {
    return asObject(text.slice(start, end + 1));
  } catch {
    // One repair only: a closing bracket that matches nothing open is dropped (the local 30B closed an object a brace
    // early on a real catch-up, 2026-10-08). A reply cut short stays unreadable: nothing is ever added.
    try { return asObject(dropStrayClosers(text.slice(start, end + 1))); } catch { return null; }
  }
}

function dropStrayClosers(json) {
  const open = [];
  let out = '';
  let inString = false;
  for (let at = 0; at < json.length; at += 1) {
    const char = json[at];
    if (inString) {
      out += char;
      if (char === '\\') { out += json[at + 1] ?? ''; at += 1; } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') open.push(char);
    else if (char === '}' || char === ']') {
      if (open.at(-1) !== (char === '}' ? '{' : '[')) continue;
      open.pop();
    }
    out += char;
  }
  return out;
}
