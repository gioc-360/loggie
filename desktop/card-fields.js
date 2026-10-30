// The fields a workstream card carries from its workstream and its place in the ranking, set here and nowhere else
// (2026-10-17: the card was built field by field in main.js, and four fields the screen reads never made it: a renamed
// card kept its old name, Inbox and Chats showed Edit and Dismiss, Matters more/less and Park never showed as set).
// Pure, so a test can hold main.js's card to what the renderer reads.
export function cardFields(workstream = {}, ranked = null, priorities = null) {
  return {
    // The name the user gave the card (Edit name); the workstream keeps its own name for its mail.
    label: workstream.label || null,
    // Inbox, Chats and a folder of open moves are not the user's workspaces: no Edit, no Dismiss.
    inbox: Boolean(workstream.inbox), chats: Boolean(workstream.chats), folder: Boolean(workstream.folder),
    stake: workstream.stake || 'normal',
    // priority: this card's place in the date order, its next due date, whether it is idle, its stake and park.
    priority: ranked ? { rank: ranked.rank, due: ranked.due, idle: Boolean(ranked.idle), stake: ranked.stake || workstream.stake || 'normal',
      parked: Boolean(ranked.parked), parkedUntil: ranked.parkedUntil || null,
      source: priorities?.source ?? null, note: priorities?.note || null, at: priorities?.at ?? null } : null,
  };
}
