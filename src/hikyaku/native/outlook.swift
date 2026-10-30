// hikyaku's Outlook reply helper. The new Outlook for Mac exposes no messages to AppleScript, so this drives
// its window through the macOS accessibility layer, the way a screen reader does:
//   find the email (search + rows) -> verify sender and date in the reading pane -> press that message's
//   Reply -> audit the reply (To, Cc, subject) -> paste the draft into the reply body -> audit the body -> STOP.
// It never sends. Every step checks what it sees, and any doubt ends the run with a status instead of a guess.
// Elements are found by their accessibility identifiers (Search Bar, messageHeaderFromContent,
// messageHeaderTimeStampContent, messageHeaderContextualControlsReplyButton, toTextField), mapped read-only on
// 2026-10-03 and 2026-10-04.
//
// Read, decide, act. Every decision (which rows are candidates, which header to reply on, which text area is the
// body, whether the reply is addressed right, whether the paste came out right) is a pure function of a Node: a
// plain copy of part of the accessibility tree. Live runs copy the tree and decide on the copy; `decide` runs the
// same functions on a recorded copy, so a past failure is a test that never touches Outlook.
//
//   hikyaku-outlook check
//   hikyaku-outlook reply --sender a@b.com --subject "Re: x" --date ISO --body-file f [--me a@b] [--expect f]
//                         [--snapshot-dir d] [--background] [--dry-run | --decide-only | --stop-after-reply]
//   hikyaku-outlook snapshot --out DIR        (read-only: presses, selects and focuses nothing)
//   hikyaku-outlook decide --case FILE [--now ISO]   (offline: no Outlook, no Accessibility needed)
// Prints one JSON object: {"status": ..., "detail": ..., and what the run saw}.
import Cocoa
import ApplicationServices

let OUTLOOK = "com.microsoft.Outlook"
let started = Date()

// What the run learned, merged into every exit line: the attempt log keeps it whether the run succeeds or stops.
var facts: [String: Any] = [:]
var findings: [[String: String]] = []
// Runs on every exit; background mode sets it to hand the front back to the user's app after Outlook flashed.
var onExit: () -> Void = {}
// Checks that can only run after the front is handed back (where focus went, whether the reply is still open).
var atExit: () -> Void = {}
func emit(_ status: String, _ detail: String, _ extra: [String: Any] = [:]) -> Never {
  onExit()
  atExit()
  var out = facts
  for (k, v) in extra { out[k] = v }
  out["findings"] = findings.map { $0["code"]! }
  if !findings.isEmpty { out["finding_messages"] = findings.map { $0["message"]! } }
  // "replied" means nothing looked wrong. A reply with any finding reports the first finding instead, so a
  // wrong reply can never pass as a right one (silent-wrong is 0 by construction, and the metrics check it).
  out["status"] = status == "replied" && !findings.isEmpty ? findings[0]["code"]! : status
  out["detail"] = status == "replied" && !findings.isEmpty ? "\(findings[0]["message"]!) The draft is in the reply; nothing was sent." : detail
  out["ms"] = Int(Date().timeIntervalSince(started) * 1000)
  let data = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
  exit(0)
}
func finding(_ code: String, _ message: String, stop: Bool) {
  findings.append(["code": code, "message": message, "severity": stop ? "stop" : "warn"])
}

// --- Node: a plain copy of an accessibility element and its children.
struct Node: Codable {
  var role = "", id = "", title = "", desc = "", value = ""
  var settable = false, focused = false, enabled = true
  var path: [Int] = []
  var children: [Node] = []
  init() {}
  init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    role = try c.decodeIfPresent(String.self, forKey: .role) ?? ""
    id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
    title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
    desc = try c.decodeIfPresent(String.self, forKey: .desc) ?? ""
    value = try c.decodeIfPresent(String.self, forKey: .value) ?? ""
    settable = try c.decodeIfPresent(Bool.self, forKey: .settable) ?? false
    focused = try c.decodeIfPresent(Bool.self, forKey: .focused) ?? false
    enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
    path = try c.decodeIfPresent([Int].self, forKey: .path) ?? []
    children = try c.decodeIfPresent([Node].self, forKey: .children) ?? []
  }
}
// One recorded copy, with the elements the run held at that moment marked by path.
struct Snap: Codable {
  var root: Node
  var toPath: [Int]? = nil
  var focusedPath: [Int]? = nil
  var bodyPath: [Int]? = nil
}
// What the reply should look like, written by draft.js from REPLY.json and settings (never derived from the tree).
struct Expect: Codable {
  var sender: String
  var me: [String]? = nil
  var to: [String]? = nil
  var cc: [String]? = nil
  var subject: String? = nil
  var date: String? = nil
  var draft: String? = nil
  var background: Bool? = nil
}

// --- pure helpers over Node
func nodes(_ root: Node, _ match: (Node) -> Bool) -> [Node] {
  var out: [Node] = []
  func go(_ n: Node) { if match(n) { out.append(n) }; n.children.forEach(go) }
  go(root)
  return out
}
func node(_ root: Node, _ path: [Int]) -> Node? {
  guard path.count >= root.path.count, Array(path.prefix(root.path.count)) == root.path else { return nil }
  var cur = root
  for i in path.dropFirst(root.path.count) {
    guard i < cur.children.count else { return nil }
    cur = cur.children[i]
  }
  return cur
}
func withId(_ root: Node, _ id: String) -> [Node] { nodes(root) { $0.id == id } }
func clean(_ s: String) -> String {
  s.replacingOccurrences(of: "\u{fffc}", with: "").replacingOccurrences(of: "\u{00a0}", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
}

func norm(_ s: String) -> String {
  var t = s.lowercased()
  while let r = t.range(of: #"^\s*(re|fw|fwd)\s*:\s*"#, options: .regularExpression) { t.removeSubrange(r) }
  return t.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
}

// The reading pane shows relative times: "Today at 09:57", "Yesterday at 18:02", "Mon 9/29", "9/20/2026".
// Returns the calendar day it names, or nil when the format is unknown (then the date cannot vouch).
func dayOf(_ shown: String, now: Date) -> DateComponents? {
  let cal = Calendar.current
  let s = shown.trimmingCharacters(in: .whitespaces)
  let low = s.lowercased()
  if low.hasPrefix("today") { return cal.dateComponents([.year, .month, .day], from: now) }
  if low.hasPrefix("yesterday") { return cal.dateComponents([.year, .month, .day], from: cal.date(byAdding: .day, value: -1, to: now)!) }
  let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX")
  for format in ["EEEE, MMMM d, yyyy HH:mm", "EEEE, MMMM d, yyyy h:mm a", "EEEE, MMMM d, yyyy", "MMMM d, yyyy HH:mm", "MMMM d, yyyy", "M/d/yyyy h:mm a", "M/d/yyyy HH:mm", "M/d/yyyy", "M/d/yy h:mm a", "M/d/yy", "EEE M/d/yyyy h:mm a", "EEE M/d/yyyy HH:mm", "EEE M/d/yyyy", "EEE M/d", "MMM d, yyyy", "MMM d"] {
    f.dateFormat = format
    for candidate in [s, s.replacingOccurrences(of: " at ", with: " ")] {
      if let d = f.date(from: candidate) {
        var c = cal.dateComponents([.year, .month, .day], from: d)
        if !format.contains("y") { c.year = cal.component(.year, from: now) }
        return c
      }
    }
  }
  // Weekday names within the last week ("Mon at 10:12").
  let names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
  if let i = names.firstIndex(where: { low.hasPrefix($0) }) {
    for back in 0..<7 {
      let d = cal.date(byAdding: .day, value: -back, to: now)!
      if cal.component(.weekday, from: d) == i + 1 { return cal.dateComponents([.year, .month, .day], from: d) }
    }
  }
  return nil
}

// The shown timestamp as a full date and time, for picking the newest message ("Thursday, September 24, 2026 at
// 08:15", "Today at 09:57"). Nil when the format is unknown.
func whenOf(_ shown: String, now: Date) -> Date? {
  let cal = Calendar.current
  let s = shown.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: " at ", with: " ")
  let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX")
  for format in ["EEEE, MMMM d, yyyy HH:mm", "EEEE, MMMM d, yyyy h:mm a", "MMMM d, yyyy HH:mm", "M/d/yyyy h:mm a", "M/d/yyyy HH:mm", "EEE M/d/yyyy h:mm a", "EEE M/d/yyyy HH:mm"] {
    f.dateFormat = format
    if let d = f.date(from: s) { return d }
  }
  guard let day = dayOf(shown, now: now), let base = cal.date(from: day) else { return nil }
  if let m = s.range(of: #"(\d{1,2}):(\d{2})"#, options: .regularExpression) {
    let hm = s[m].split(separator: ":").compactMap { Int($0) }
    return cal.date(bySettingHour: hm[0], minute: hm[1], second: 0, of: base)
  }
  return base
}

// The shown message must not be older than the email the draft answers (one day of slack: the thread date is
// UTC, the pane shows local time). Newer is right: conversation view shows the latest message in the thread,
// and replying to it is what keeps the reply threaded.
func notBefore(_ shown: DateComponents, _ original: Date) -> Bool {
  let cal = Calendar.current
  guard let sd = cal.date(from: shown) else { return false }
  let od = cal.startOfDay(for: original)
  return (cal.dateComponents([.day], from: od, to: sd).day ?? -99) >= -1
}

func localPart(_ address: String) -> String { address.split(separator: "@").first.map(String.init) ?? address }
// A recipient token ("jess lu, jess@school.edu, offline") names a person by address, by the address's local part,
// or by the display name Outlook learned from their header.
func names(_ token: String, _ address: String, name: String = "") -> Bool {
  let a = address.lowercased()
  guard !a.isEmpty else { return false }
  return token.contains(a) || token.contains(localPart(a)) || (!name.isEmpty && token.contains(name.lowercased()))
}
func addressesIn(_ s: String) -> [String] {
  guard let re = try? NSRegularExpression(pattern: #"[\w.+'-]+@[\w-]+(?:\.[\w-]+)+"#) else { return [] }
  return re.matches(in: s, range: NSRange(s.startIndex..., in: s)).compactMap { Range($0.range, in: s).map { String(s[$0]).lowercased() } }
}

// --- decide: rows
// Rows whose description carries the subject, one message each. Skipped: conversation rows ("4 messages"),
// whose reading pane shows the newest item even when that is a deleted draft, and anything in Drafts or the
// search suggestion list (measured 2026-10-03). Deleted Items only when the thread has no other copy (a thread
// deleted by accident still threads; drafts in it show no sender header and are skipped when opened).
// The subject must start where a row's subject starts: after the start, a ", " (the sender's name, "2 messages") or a
// Re:/Fw: prefix. Inside a longer subject it is another thread: "Another class | Request to attend remotely
// next week (travel)" to a classmate was taken for the professor's "Request to attend remotely next week (leg
// injury)", the Inbox showed only it, and the reply stopped as no-verified-match without searching (2026-10-12).
func subjectAt(_ row: String, _ q: String) -> Bool {
  row.range(of: #"(^|,\s+|\b(re|fw|fwd)\s*:\s*)"# + NSRegularExpression.escapedPattern(for: q), options: .regularExpression) != nil
}
func candidateIndices(_ rows: [String], _ query: String) -> [Int] {
  let q = String(query.prefix(40))
  let hits = rows.indices.filter { i in
    let d = norm(rows[i])
    return subjectAt(d, q) && !d.contains(" messages,") && !d.contains("folder: drafts") && !d.contains("search suggestion")
  }
  let live = hits.filter { !norm(rows[$0]).contains("folder: deleted items") }
  return live.isEmpty ? hits : live
}
// A thread can list as one collapsed conversation row ("5 messages, ..."); its single messages appear only once
// it is expanded (measured 2026-10-03).
func conversationIndices(_ rows: [String], _ query: String) -> [Int] {
  rows.indices.filter { subjectAt(norm(rows[$0]), String(query.prefix(40))) && norm(rows[$0]).contains(" messages,") }
}
// A row's identity without its state words: opening an unread email drops "Unread," from its description, so a
// row remembered by its raw text cannot be found again (measured on Jamie's thread, 2026-10-03).
func rowKey(_ text: String) -> String {
  norm(text).replacingOccurrences(of: #"\b(\d+ unread messages?|unread|replied|forwarded|flagged|pinned|expanded|collapsed),?\s*"#, with: "", options: .regularExpression)
}

// --- decide: which message in the reading pane to reply on
// The reply goes on the NEWEST real message in the thread that involves the person, whoever sent it: for a
// follow-up that is the user's own last note, with the person's email quoted below it. Gio, 2026-10-03, after a
// reply landed on Lena's older email: "this is the thread that should be opened" (his Sep 24 Sent message).
struct Header {
  var fromPath: [Int]
  var replyPath: [Int]? = nil
  var replyAllPath: [Int]? = nil
  var from = "", recipients = "", stamp = ""
  var when: Date? = nil
  var own = false, fromPerson = false, ok = false
  var reason = ""
  var dict: [String: Any] {
    var d: [String: Any] = ["from": from, "own": own, "ok": ok, "stamp": stamp, "reason": reason]
    if let w = when { d["when"] = ISO8601DateFormatter().string(from: w) }
    return d
  }
}
func headerVerdicts(_ pane: Node, sender: String, me: [String], target: Date?, now: Date, background: Bool) -> (headers: [Header], personName: String) {
  // A conversation shows several messages at once, each with its own header. Judge them all and take the newest
  // that qualifies, the same way every time: taking whichever header came first once judged one message and pressed
  // Reply on another (Jess's thread, 2026-10-05).
  var out: [Header] = []
  var personName = ""
  for from in withId(pane, "messageHeaderFromContent") {
    var h = Header(fromPath: from.path)
    h.reason = "no-header"
    for up in 1...6 {
      guard from.path.count - up >= pane.path.count, let b = node(pane, Array(from.path.dropLast(up))) else { break }
      // Never climb into a box that holds another message's header: its date and buttons belong to that message.
      // Climbing too far gave Jess's 9/30 header the 09:31 date of the user's reply above it, and the choice
      // between Reply and Reply all flipped from run to run (decide-only, 2026-10-05).
      if withId(b, "messageHeaderFromContent").count > 1 { break }
      let rb = withId(b, "messageHeaderContextualControlsReplyButton").first
      let ts = withId(b, "messageHeaderTimeStampContent").first
      guard rb != nil || (background && ts != nil) else { continue }
      // From alone decides who sent it. From and recipients together once made the user's own message pass as the
      // person's (Jess's thread, 2026-10-05: the reply came out addressed to the user).
      h.from = from.value.lowercased()
      h.recipients = (withId(b, "messageHeaderRecipientsContent").first?.value ?? "").lowercased()
      h.own = me.contains { !$0.isEmpty && h.from.contains($0) }
      h.fromPerson = h.from.contains(sender)
      if h.fromPerson, personName.isEmpty { personName = h.from.components(separatedBy: "<").first?.trimmingCharacters(in: .whitespaces) ?? "" }
      h.stamp = ts?.value ?? ""
      h.when = whenOf(h.stamp, now: now)
      h.replyPath = rb?.path
      h.replyAllPath = withId(b, "messageHeaderContextualControlsReplyAllButton").first?.path
      // The person's own message, or the user's own note to the person (a follow-up goes on it, Gio 2026-10-03).
      if !(h.fromPerson || (h.own && h.recipients.contains(sender))) { h.reason = h.own ? "own-not-to-person" : "sender"; break }
      if let t = target {
        guard let day = dayOf(h.stamp, now: now), notBefore(day, t) else { h.reason = "date"; break }   // unknown or older: cannot vouch
      }
      h.ok = true; h.reason = ""
      break
    }
    out.append(h)
  }
  return (out, personName)
}
// Ties go to the user's own note, so the same pane always gives the same answer.
func chosen(_ headers: [Header]) -> Header? {
  headers.filter { $0.ok }.max { (($0.when ?? .distantPast), $0.own ? 1 : 0) < (($1.when ?? .distantPast), $1.own ? 1 : 0) }
}
// Across the opened rows, the newest chosen message wins; the first row wins a tie.
func bestAcross(_ picks: [Header?]) -> Int? {
  var best: Int? = nil
  for (i, p) in picks.enumerated() {
    guard let w = p?.when else { continue }
    if best == nil || w > picks[best!]!.when! { best = i }
  }
  return best
}

// --- decide: the reply's body and recipients
// Only a text area Outlook lets us edit can be the reply body. In a thread that already has a reply, the reading
// pane also shows earlier messages as read-only text areas; picking one of those made the paste vanish (Jess's
// thread, 2026-10-05: the reply opened with an empty body). The focused one wins; otherwise the shortest (a fresh
// reply holds at most a signature and the quote, earlier messages hold whole emails).
func isBody(_ n: Node) -> Bool { n.role == "AXTextArea" && n.settable && !n.value.hasPrefix("Try advanced search") }
func pickBody(_ s: Snap) -> [Int]? {
  let bodies = nodes(s.root, isBody)
  if let f = s.focusedPath, let hit = bodies.first(where: { $0.path == f }) { return hit.path }
  return bodies.min { $0.value.count < $1.value.count }?.path
}
// The recipient tokens of one field: the texts of its children ("Jess Lu, jess@school.edu, Offline"). A field
// that shows none falls back to its own value, then to the row around it (the To row, nothing wider: searching the
// whole reply once passed on the person's address in the quoted history while To held only the user).
let LABELS: Set<String> = ["", "to", "cc", "to:", "cc:", "to recipients", "cc recipients"]
func tokens(_ field: Node, in root: Node) -> [String] {
  let texts = { (ns: [Node]) in ns.flatMap { [$0.value, $0.desc, $0.title] }.map { clean($0).lowercased() }.filter { !LABELS.contains($0) } }
  var out = texts(nodes(field) { $0.path != field.path })
  if out.isEmpty { out = texts([Node(value: field.value)]) }
  if out.isEmpty, field.path.count > root.path.count, let row = node(root, Array(field.path.dropLast())) { out = texts(nodes(row) { _ in true }) }
  var seen = Set<String>()
  return out.filter { seen.insert($0).inserted }
}
extension Node { init(value: String) { self.init(); self.value = value } }
func ccField(_ root: Node) -> Node? {
  withId(root, "ccTextField").first ?? nodes(root) { $0.role == "AXTextField" && $0.desc.lowercased().hasPrefix("cc") }.first
}

// Before the paste. A stop finding means nothing is pasted; a warn finding is pasted and reported.
func auditBeforePaste(_ s: Snap, _ e: Expect, personName: String) -> [String: Any] {
  let sender = e.sender.lowercased()
  let me = (e.me ?? []).map { $0.lowercased() }.filter { !$0.isEmpty }
  let toNode = s.toPath.flatMap { node(s.root, $0) } ?? withId(s.root, "toTextField").first
  let to = toNode.map { tokens($0, in: s.root) } ?? []
  let cc = ccField(s.root).map { tokens($0, in: s.root) } ?? []
  let subject = withId(s.root, "subjectTextField").first?.value ?? ""
  let toPerson = to.contains { names($0, sender, name: personName) }
  let own = (to + cc).contains { t in me.contains { names(t, $0) } }
  var facts: [String: Any] = ["to_tokens": to, "cc_tokens": cc, "subject": subject, "own_in_recipients": own]
  if !toPerson {
    finding("reply-wrong-recipient", "The reply opened without \(sender) on its To line, so nothing was pasted.", stop: true)
  }
  if own {
    finding("reply-includes-you", "The reply opened with your own address on it, so nothing was pasted.", stop: true)
  }
  if !subject.isEmpty {
    if subject.range(of: #"^\s*(fw|fwd)\s*:"#, options: [.regularExpression, .caseInsensitive]) != nil {
      finding("audit-forward-not-reply", "Outlook opened a forward, not a reply, so nothing was pasted.", stop: true)
    } else if let want = e.subject, !norm(want).isEmpty, !norm(subject).contains(norm(want)), !norm(want).contains(norm(subject)) {
      finding("audit-subject-mismatch", "The reply's subject is \"\(subject)\", but the thread is \"\(want)\", so nothing was pasted.", stop: true)
    }
    facts["subject_ok"] = findings.allSatisfy { !$0["code"]!.hasPrefix("audit-subject") && $0["code"] != "audit-forward-not-reply" }
  }
  // Anyone on the reply the task did not name. Reply all on the user's own note keeps everyone the user wrote
  // to, which can be right, so this is reported, not stopped: the user reads the To line before Send.
  let known = Set([sender] + (e.to ?? []).map { $0.lowercased() } + (e.cc ?? []).map { $0.lowercased() } + me)
  // A "+tag" on an address is the same mailbox ("kcartwright2+m791...@" is kcartwright2@, a recruiting system's
  // tracking tag): 4 of 4 "also addressed to" notes on 2026-10-21 were the sender this way.
  let untagged = { (a: String) -> String in a.replacingOccurrences(of: #"\+[^@]*@"#, with: "@", options: .regularExpression) }
  let knownMailbox = Set(known.map(untagged))
  let extra = (to + cc).flatMap(addressesIn).filter { !known.contains($0) && !knownMailbox.contains(untagged($0)) }
  if !extra.isEmpty { finding("audit-extra-recipient", "The reply is also addressed to \(extra.joined(separator: ", ")); check the To and Cc lines first.", stop: false) }
  // Cc the task asked for. The helper does not add Cc in Outlook yet, so a task with Cc says what to add.
  let wantCc = (e.cc ?? []).map { $0.lowercased() }.filter { !$0.isEmpty }
  let missingCc = wantCc.filter { a in !cc.contains { names($0, a) } }
  if !missingCc.isEmpty { finding("audit-cc-missing", "Add \(missingCc.joined(separator: ", ")) on Cc yourself; hikyaku does not fill Cc in Outlook yet.", stop: false) }
  return facts
}

// After the paste. The body text area holds the user's signature and the quoted history; everything above the
// first quote marker is what the user wrote.
let CLOSING = #"^(best( regards)?|kind regards|regards|all the best|best wishes|cheers|sincerely|warmly|warm regards)[,!.]?$"#
// Any closing, thanks included: a reply with none ends mid-air (2026-10-05: replies get no Outlook signature, and the
// draft's own "Best regards," had been cut on the belief that the signature would bring one).
let ANY_CLOSING = #"^(best( regards)?|kind regards|regards|all the best|best wishes|thanks( so much)?|thank you( so much)?|many thanks|cheers|sincerely|warmly|warm regards)[,!.]?$"#
func aboveQuote(_ text: String) -> [String] {
  var out: [String] = []
  for raw in text.components(separatedBy: .newlines) {
    let line = clean(raw)
    if line.range(of: #"^(from:\s|on .+ wrote:$|-+\s*original message\s*-+$|_{8,}$)"#, options: [.regularExpression, .caseInsensitive]) != nil { break }
    out.append(line)
  }
  return out
}
func occurrences(_ needle: String, in hay: String) -> Int {
  guard !needle.isEmpty else { return 0 }
  return hay.components(separatedBy: needle).count - 1
}
func squash(_ s: String) -> String { s.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ") }
func auditAfterPaste(before: String, after: String, draftFirstLine: String) -> [String: Any] {
  let signature = squash(aboveQuote(before).joined(separator: "\n"))
  let written = aboveQuote(after)
  let writtenText = squash(written.joined(separator: "\n"))
  let first = written.first { !$0.isEmpty } ?? ""
  let want = clean(draftFirstLine)
  let draftCount = occurrences(squash(want), in: writtenText)
  let signatureCount = signature.isEmpty ? 0 : occurrences(signature, in: writtenText)
  let signOffs = written.filter { $0.range(of: CLOSING, options: [.regularExpression, .caseInsensitive]) != nil }.count
  if draftCount > 0 && first != want { finding("audit-body-not-first", "The draft landed below the signature or the quote; move it to the top.", stop: false) }
  if draftCount > 1 { finding("audit-double-draft", "The draft appears \(draftCount) times in the reply; delete the extra copy.", stop: false) }
  if signatureCount > 1 { finding("audit-double-signature", "Your signature appears \(signatureCount) times; delete one.", stop: false) }
  let closed = written.contains { $0.range(of: ANY_CLOSING, options: [.regularExpression, .caseInsensitive]) != nil }
  if draftCount > 0 && !closed && signature.isEmpty { finding("audit-no-sign-off", "The reply ends with no closing line and no signature; add one.", stop: false) }
  if signOffs > 1 { finding("audit-double-sign-off", "The reply has \(signOffs) closing lines (the draft's and your signature's); delete one.", stop: false) }
  return ["body_first_line_ok": first == want, "draft_count": draftCount, "signature_count": signatureCount, "sign_off_count": signOffs, "signature_chars": signature.count]
}

// --- args
let args = CommandLine.arguments
func arg(_ name: String) -> String? {
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}
let command = args.count > 1 ? args[1] : ""
let iso = ISO8601DateFormatter()

// --- decide: the same decisions on a recorded case, offline. A case file holds the expectation and any of:
// rows (row texts), panes (one Snap per opened candidate), composePre and composePost (Snaps of the reply).
struct Case: Codable {
  var expect: Expect
  var rows: [String]? = nil
  var panes: [Snap]? = nil
  var composePre: Snap? = nil
  var composePost: Snap? = nil
}
if command == "decide" {
  guard let file = arg("--case"), let data = FileManager.default.contents(atPath: file) else { emit("usage", "hikyaku-outlook decide --case FILE [--now ISO]") }
  let c: Case
  do { c = try JSONDecoder().decode(Case.self, from: data) } catch { emit("bad-case", "\(error)") }
  let now = arg("--now").flatMap { iso.date(from: $0) } ?? Date()
  let e = c.expect
  let sender = e.sender.lowercased()
  let query = norm(e.subject ?? "")
  var out: [String: Any] = [:]
  if let rows = c.rows {
    out["candidates"] = candidateIndices(rows, query)
    out["conversations"] = conversationIndices(rows, query)
    out["row_keys"] = candidateIndices(rows, query).map { rowKey(rows[$0]) }
  }
  var personName = ""
  if let panes = c.panes {
    let target = e.date.flatMap { iso.date(from: $0) }
    let judged = panes.map { headerVerdicts($0.root, sender: sender, me: (e.me ?? []).map { $0.lowercased() }, target: target, now: now, background: e.background ?? true) }
    personName = judged.map { $0.personName }.first { !$0.isEmpty } ?? ""
    let picks = judged.map { chosen($0.headers) }
    out["headers"] = judged.map { $0.headers.map { $0.dict } }
    if let b = bestAcross(picks), let h = picks[b] {
      out["chosen"] = ["pane": b, "own": h.own, "button": h.own ? "reply-all" : "reply", "path": (h.own ? h.replyAllPath : h.replyPath) ?? h.fromPath, "from": h.from, "stamp": h.stamp] as [String: Any]
    }
  }
  out["person_name"] = personName
  var bodyBefore = ""
  if let pre = c.composePre {
    out["audit_pre"] = auditBeforePaste(pre, e, personName: personName)
    let path = pre.bodyPath ?? pickBody(pre)
    out["body_path"] = path.map { $0 as Any } ?? NSNull()
    bodyBefore = path.flatMap { node(pre.root, $0) }?.value ?? ""
  }
  if let post = c.composePost, let path = post.bodyPath ?? pickBody(post) {
    out["audit_post"] = auditAfterPaste(before: bodyBefore, after: node(post.root, path)?.value ?? "", draftFirstLine: e.draft ?? "")
  }
  emit("decided", "Decisions on a recorded case; nothing live was touched.", out)
}

// --- read: the live tree
func attr(_ e: AXUIElement, _ k: String) -> CFTypeRef? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(e, k as CFString, &v) == .success ? v : nil
}
func text(_ e: AXUIElement, _ k: String) -> String { (attr(e, k) as? String) ?? "" }
func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func parent(_ e: AXUIElement) -> AXUIElement? {
  guard let p = attr(e, kAXParentAttribute) else { return nil }
  return (p as! AXUIElement)
}
func editable(_ e: AXUIElement) -> Bool {
  var settable: DarwinBoolean = false
  return AXUIElementIsAttributeSettable(e, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
}

// Depth-first search, bounded so a huge tree cannot hang the run. Outlook's search box lists itself as its own
// child (measured 2026-10-03: a walk visited it 11,998 times), so the walk never descends into it and never
// visits the same element twice.
// Top-down, so the first match is the topmost one. `max` stops the walk after that many matches and `into: false`
// does not look inside a match: the Inbox keeps about 1,800 rows in the tree, and walking all of them for every
// look cost seconds each time (2026-10-09: a dry run took 30-55 s in the Inbox view, 4 s in a search view).
// An element with this many children is the message list (about 1,800 rows in the Inbox). No header, reply, field
// or button Loggie looks for lives inside it, so only the row scan (bigLists: true) walks into it; every other look
// skips it. With it skipped, a whole Inbox window reads in about 0.1 s (2026-10-09).
let BIG = 300
func childCount(_ e: AXUIElement) -> Int { var n: CFIndex = 0; AXUIElementGetAttributeValueCount(e, kAXChildrenAttribute as CFString, &n); return n }
func find(_ root: AXUIElement, limit: Int = 20000, max: Int = Int.max, into: Bool = true, bigLists: Bool = false, _ match: (AXUIElement) -> Bool) -> [AXUIElement] {
  var found: [AXUIElement] = [], stack = [root], seen = 0
  var visited = Set<Int>()
  while let e = stack.popLast(), seen < limit, found.count < max {
    let key = Int(CFHash(e))
    if visited.contains(key) { continue }
    visited.insert(key); seen += 1
    if match(e) { found.append(e); if !into { continue } }
    if text(e, "AXIdentifier") == "Search Bar" { continue }
    if !bigLists && childCount(e) > BIG { continue }
    stack.append(contentsOf: children(e).reversed())
  }
  return found
}
func byId(_ root: AXUIElement, _ id: String) -> [AXUIElement] { find(root) { text($0, "AXIdentifier") == id } }

// Copies a subtree into Nodes and keeps each live element by path, so a decision made on the copy acts on the
// element it named. Same bounds as find; text areas keep 8,000 characters (a reply body with its quote), other
// values 500. A text area's children are its text runs, already in its value, so they are not copied.
final class Table { var map: [[Int]: AXUIElement] = [:] }
func snapshot(_ root: AXUIElement, _ table: Table, limit: Int = 6000) -> Node {
  var budget = limit
  var visited = Set<Int>()
  func copy(_ e: AXUIElement, _ path: [Int], _ depth: Int) -> Node {
    var n = Node()
    n.role = text(e, kAXRoleAttribute); n.id = text(e, "AXIdentifier"); n.title = text(e, kAXTitleAttribute); n.desc = text(e, kAXDescriptionAttribute)
    n.value = String(((attr(e, kAXValueAttribute) as? String) ?? "").prefix(n.role == "AXTextArea" ? 8000 : 500))
    n.settable = editable(e); n.focused = (attr(e, kAXFocusedAttribute) as? Bool) ?? false; n.enabled = (attr(e, kAXEnabledAttribute) as? Bool) ?? true
    n.path = path
    table.map[path] = e
    guard n.id != "Search Bar", n.role != "AXTextArea", depth < 40, childCount(e) <= BIG else { return n }
    for (i, c) in children(e).enumerated() {
      let key = Int(CFHash(c))
      guard budget > 0, !visited.contains(key) else { continue }
      visited.insert(key); budget -= 1
      n.children.append(copy(c, path + [i], depth + 1))
    }
    return n
  }
  visited.insert(Int(CFHash(root)))
  return copy(root, [], 0)
}
func pathOf(_ e: AXUIElement?, _ table: Table) -> [Int]? {
  guard let e = e else { return nil }
  return table.map.first { CFEqual($0.value, e) }?.key
}
func encode<T: Encodable>(_ v: T) -> Data { let enc = JSONEncoder(); enc.outputFormatting = [.sortedKeys]; return try! enc.encode(v) }
// --snapshot-dir: every copy the run decided on is saved there, so a wrong reply can be replayed with decide.
let snapshotDir = arg("--snapshot-dir")
func save(_ name: String, _ data: Data) {
  guard let dir = snapshotDir else { return }
  try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
  FileManager.default.createFile(atPath: (dir as NSString).appendingPathComponent(name), contents: data)
}

func waitFor<T>(_ seconds: Double, _ probe: () -> T?) -> T? {
  let end = Date().addingTimeInterval(seconds)
  repeat {
    if let v = probe() { return v }
    usleep(80_000)
  } while Date() < end
  return nil
}

// Step timings for the attempt log.
var steps: [String: Int] = [:]
var stepStart = Date()
func step(_ name: String) { steps[name] = Int(Date().timeIntervalSince(stepStart) * 1000); stepStart = Date(); facts["steps_ms"] = steps }

if !AXIsProcessTrusted() { emit("not-trusted", "macOS has not allowed this app to control other apps (Accessibility).") }
guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: OUTLOOK).first else {
  emit("no-outlook", "Microsoft Outlook is not running.")
}
let root = AXUIElementCreateApplication(app.processIdentifier)
if command == "check" { emit("ok", "Accessibility allowed and Outlook running.") }

func rowText(_ e: AXUIElement) -> String { children(e).map { text($0, kAXDescriptionAttribute) }.joined(separator: " ") }

// --- snapshot: a read-only copy of what Outlook shows now. Nothing is pressed, selected or focused.
if command == "snapshot" {
  guard let out = arg("--out") else { emit("usage", "hikyaku-outlook snapshot --out DIR") }
  try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
  let windows = (attr(root, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  var written: [String] = []
  func write(_ name: String, _ data: Data) { FileManager.default.createFile(atPath: (out as NSString).appendingPathComponent(name), contents: data); written.append(name) }
  for (i, w) in windows.enumerated() {
    let table = Table()
    let tree = snapshot(w, table)
    let focused = attr(root, kAXFocusedUIElementAttribute).map { $0 as! AXUIElement }
    write("window-\(i).json", encode(Snap(root: tree, focusedPath: pathOf(focused, table))))
    let rows = find(w) { text($0, kAXRoleAttribute) == "AXRow" }.map(rowText)
    write("rows-\(i).json", try! JSONSerialization.data(withJSONObject: rows, options: [.prettyPrinted]))
    for (j, to) in byId(w, "toTextField").enumerated() {
      var box = parent(to)
      for _ in 0..<8 {
        guard let b = box else { break }
        if !find(b, limit: 4000, { text($0, kAXRoleAttribute) == "AXTextArea" && editable($0) }).isEmpty {
          let t = Table(); let tree = snapshot(b, t)
          var s = Snap(root: tree, toPath: pathOf(to, t), focusedPath: pathOf(focused, t)); s.bodyPath = pickBody(s)
          write("compose-\(i)-\(j).json", encode(s))
          break
        }
        box = parent(b)
      }
    }
  }
  emit("snapshot", "Copied what Outlook shows now; nothing was pressed or selected.", ["files": written, "dir": out])
}

guard command == "reply", let sender = arg("--sender")?.lowercased(), let subject = arg("--subject") else {
  emit("usage", "hikyaku-outlook check | snapshot --out DIR | decide --case FILE | reply --sender EMAIL --subject TEXT [--date ISO] --body-file PATH [--dry-run]")
}
let dryRun = args.contains("--dry-run")
// What the reply should look like: the user's own addresses (a message from one is the user's own, and none may
// be a recipient), the expected To and Cc. From --expect (draft.js), else from the plain arguments.
var expect = Expect(sender: sender, me: [arg("--me") ?? ""], to: [sender], subject: subject, date: arg("--date"))
if let f = arg("--expect"), let data = FileManager.default.contents(atPath: f), let e = try? JSONDecoder().decode(Expect.self, from: data) {
  expect = e
  expect.sender = sender
  expect.me = Array(Set((e.me ?? []) + [arg("--me") ?? ""])).filter { !$0.isEmpty }
}
let me = (expect.me ?? []).map { $0.lowercased() }.filter { !$0.isEmpty }
// Background mode: no keystrokes and no bringing Outlook forward, so the user can keep using another app.
// Reply is pressed through accessibility only; the draft is inserted into the body through accessibility.
let background = args.contains("--background")
let previousApp = NSWorkspace.shared.frontmostApplication
let previousFront = previousApp?.bundleIdentifier ?? ""
func openApp(_ bundle: String) {
  let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/open"); p.arguments = ["-b", bundle]
  try? p.run(); p.waitUntilExit()
}
// The front goes back to the exact app the user was in. By bundle id it once launched a second, empty Electron
// when the user was in Loggie (every Electron app shares one id). activate() is refused while another app is
// active, so the app's own path is opened, which brings that running copy forward (measured 2026-10-04).
func returnFront() {
  guard let app = previousApp else { return }
  if let url = app.bundleURL {
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/open"); p.arguments = [url.path]
    try? p.run(); p.waitUntilExit()
  } else if let bundle = app.bundleIdentifier { openApp(bundle) }
}
// --trace prints what each opened email showed and why it passed or failed, to stderr.
let trace = args.contains("--trace")
func note(_ m: String) { if trace { FileHandle.standardError.write((m + "\n").data(using: .utf8)!) } }
let target: Date? = arg("--date").flatMap { iso.date(from: $0) }
let body = arg("--body-file").flatMap { try? String(contentsOfFile: $0, encoding: .utf8) } ?? ""
if !dryRun && body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { emit("no-draft", "The draft is empty.") }

// --- 1. bring Outlook to the front. A background process may not activate another app directly on recent
// macOS, so ask Launch Services, the way a Dock click does.
if !background {
  let opener = Process()
  opener.executableURL = URL(fileURLWithPath: "/usr/bin/open")
  opener.arguments = ["-b", OUTLOOK]
  try? opener.run(); opener.waitUntilExit()
  guard waitFor(5, { NSWorkspace.shared.frontmostApplication?.bundleIdentifier == OUTLOOK ? true : nil }) != nil else {
    emit("not-front", "Outlook did not come to the front.")
  }
}
// The main mail window is the one with the search box; a compose window may be in front of it.
let windows = (attr(root, kAXWindowsAttribute) as? [AXUIElement]) ?? []
guard let window = windows.first(where: { !find($0, max: 1) { text($0, "AXIdentifier") == "Search Bar" }.isEmpty }) else {
  emit(windows.isEmpty ? "no-window" : "no-search", windows.isEmpty ? "Outlook has no open window." : "None of Outlook's windows has the search box.")
}

AXUIElementPerformAction(window, kAXRaiseAction as CFString)
AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
usleep(400_000)

// A reply opens either in its own window or inline under the email, so the reply is found by its To field.
// To fields already open (an earlier fallback, an older draft) are never mistaken for the new reply.
func toFields() -> [AXUIElement] {
  ((attr(root, kAXWindowsAttribute) as? [AXUIElement]) ?? []).flatMap { byId($0, "toTextField") }
}

// --- 2. find the email. Recent mail is already in the Inbox list, so look there first and search only when it
// is not listed (2026-10-09: Outlook's search alone took 14.6 s cold and 3.9 s warm). Either way the email is only
// a candidate: step 3 still judges every header for sender and date before Reply. Search runs from the Inbox:
// Outlook searches only the folder in view, so a search started in Drafts finds only drafts (measured 2026-10-03).
let query = norm(subject)
// The folder list and the top of the message list: the email a task replies to is recent, or found by search, whose
// list is short. A row's own text is read from its children (rowText), so the walk does not go inside rows.
let ROWS = 250
func allRows() -> [AXUIElement] { find(window, max: ROWS, into: false, bigLists: true) { text($0, kAXRoleAttribute) == "AXRow" } }
func candidateRows() -> [AXUIElement] { let rows = allRows(); return candidateIndices(rows.map(rowText), query).map { rows[$0] } }
func conversationRows() -> [AXUIElement] { let rows = allRows(); return conversationIndices(rows.map(rowText), query).map { rows[$0] } }
// A subject can list as several conversations ("2 messages, ..."), each hiding its single emails until it is
// expanded, and Outlook keeps only ONE expanded at a time: expanding the next collapses the last. Expanding them all
// first and then reading the list once left only the last conversation's emails, so a task could see only the other
// sender's email (same subject from two people, 2026-10-05: stopped as no-verified-match, never a wrong reply). So
// each conversation is expanded in turn and its emails are judged while they show. The list also repeats rows under
// Top Results and All Results; rows are told apart by key.
func conversationKeys() -> [String] {
  var seen: [String] = []
  for r in conversationRows() { let k = rowKey(rowText(r)); if !seen.contains(k) { seen.append(k) } }
  return seen
}
func isExpanded(_ r: AXUIElement) -> Bool { norm(rowText(r)).contains("expanded,") }
func expand(_ key: String) {
  let rows = conversationRows().filter { rowKey(rowText($0)) == key }
  guard !rows.contains(where: isExpanded), let row = rows.first else { return }
  let before = candidateRows().map { rowKey(rowText($0)) }
  AXUIElementSetAttributeValue(row, kAXSelectedAttribute as CFString, kCFBooleanTrue)
  _ = waitFor(2) { candidateRows().map { rowKey(rowText($0)) } != before ? true : nil }
  usleep(500_000)
}
// In the background the confirm can leave Outlook's suggestion list showing instead of results (measured on
// Jamie's thread). Pressing the matching suggestion runs the search, through accessibility, with no keystroke.
func suggestionRows() -> [AXUIElement] {
  find(window) { e in text(e, kAXRoleAttribute) == "AXRow" && norm(rowText(e)).contains("search suggestion") && norm(rowText(e)).contains(String(query.prefix(30))) }
}
// The main window may be showing the Calendar (an invite discarded or sent leaves it there, seen 2026-10-09), where
// there is no Inbox and a search looks through events. Switch it to Mail first, through Outlook's own menu
// (View > Go To > Mail): a menu press, so the helper still posts no key but Cmd+R, Cmd+V and typed search text.
let inboxCellNow = { find(window, limit: 4000, max: 1, { text($0, kAXRoleAttribute) == "AXCell" && text($0, kAXDescriptionAttribute).hasPrefix("Inbox") }).first }
step("front")
// In background mode too (2026-10-22: 3 of 19 replies stopped here): the menu press is an accessibility action, not
// a keystroke, so it keeps background mode's rule.
if inboxCellNow() == nil {
  func item(_ menu: AXUIElement?, _ title: String) -> AXUIElement? {
    guard let menu else { return nil }
    for m in children(menu) where text(m, kAXTitleAttribute) == title { return m }
    for m in children(menu) { if let found = item(m, title), text(found, kAXTitleAttribute) == title { return found } }
    return nil
  }
  let bar = attr(root, kAXMenuBarAttribute).map { $0 as! AXUIElement }
  let view = item(bar, "View"), viewMenu = view.flatMap { children($0).first }
  let goTo = item(viewMenu, "Go To"), goMenu = goTo.flatMap { children($0).first }
  guard let mail = item(goMenu, "Mail"), AXUIElementPerformAction(mail, kAXPressAction as CFString) == .success,
        waitFor(4, { inboxCellNow() }) != nil else { emit("not-in-mail", "Outlook is showing the Calendar and did not switch to Mail. Open Mail in Outlook, then try again.") }
  note("switched Outlook from the Calendar to Mail")
  facts["switched_to_mail"] = true
}
if let inboxCell = inboxCellNow(),
   let inboxRow = parent(inboxCell) {
  AXUIElementSetAttributeValue(inboxRow, kAXSelectedAttribute as CFString, kCFBooleanTrue)
}
// The list fills in as the folder shows; read it once it has rows.
_ = waitFor(2) { allRows().isEmpty ? nil : true }
step("inbox")
var listed = !conversationRows().isEmpty || !candidateRows().isEmpty
facts["found_via"] = listed ? "inbox" : "search"
step("list")
var searchedFor = ""
if !listed {
  guard let search = find(window, max: 1, { text($0, "AXIdentifier") == "Search Bar" }).first else { emit("no-search", "Could not find Outlook's search box.") }
  // After a folder switch the box can take a moment to accept focus, so ask until it has it.
  _ = waitFor(3) { () -> Bool? in
    AXUIElementSetAttributeValue(search, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    return (attr(search, kAXFocusedAttribute) as? Bool) == true ? true : nil
  }
  AXUIElementSetAttributeValue(search, kAXValueAttribute as CFString, query as CFTypeRef)
  usleep(300_000)
  if norm(text(search, kAXValueAttribute)) != query {
    if background { emit("background-search-failed", "Setting Outlook's search text through accessibility did not take, and background mode never types.") }
    // Setting the value did not take: type it instead, but only into Outlook's focused search box.
    guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == OUTLOOK,
          (attr(search, kAXFocusedAttribute) as? Bool) == true else { emit("no-search", "Could not focus Outlook's search box.") }
    let typer = CGEventSource(stateID: .combinedSessionState)
    for ch in query.utf16 {
      for down in [true, false] {
        let e = CGEvent(keyboardEventSource: typer, virtualKey: 0, keyDown: down)
        var c = ch; e?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c); e?.post(tap: .cghidEventTap)
      }
      usleep(8_000)
    }
  }
  AXUIElementPerformAction(search, "AXConfirm" as CFString)
  searchedFor = text(search, kAXValueAttribute)
  if let suggestion = waitFor(2, { suggestionRows().first }) {
    if let cell = children(suggestion).first { AXUIElementPerformAction(cell, kAXPressAction as CFString) }
    AXUIElementSetAttributeValue(suggestion, kAXSelectedAttribute as CFString, kCFBooleanTrue)
    note("pressed the search suggestion to run the search")
    _ = waitFor(4) { suggestionRows().isEmpty ? true : nil }
  }

  listed = waitFor(8, { conversationRows().isEmpty && candidateRows().isEmpty ? nil : true }) != nil
  if !listed {
    // Outlook's search once came back empty and found the same email a minute later (Jess's thread, 2026-10-05).
    // Search once more, the same way, before giving up.
    note("   no rows; searching once more")
    AXUIElementSetAttributeValue(search, kAXValueAttribute as CFString, "" as CFTypeRef)
    usleep(500_000)
    AXUIElementSetAttributeValue(search, kAXValueAttribute as CFString, query as CFTypeRef)
    usleep(300_000)
    AXUIElementPerformAction(search, "AXConfirm" as CFString)
    if let suggestion = waitFor(2, { suggestionRows().first }), let cell = children(suggestion).first { AXUIElementPerformAction(cell, kAXPressAction as CFString) }
    listed = waitFor(10, { conversationRows().isEmpty && candidateRows().isEmpty ? nil : true }) != nil
  }
}
save("rows.json", try! JSONSerialization.data(withJSONObject: allRows().map(rowText), options: [.prettyPrinted]))
step("search")
guard listed else {
  emit("no-match", "Search found no email with that subject, twice.", ["query": query, "search_box": searchedFor])
}
let conversations = conversationKeys()
facts["conversations"] = conversations.count
if dryRun {
  emit("dry-run", "Would check the emails in \(conversations.count) conversation(s) and \(candidateRows().count) listed email(s) for sender \(sender) and press Reply on the one that matches. Nothing was pressed.", ["candidates": String(candidateRows().count)])
}

// --- 3. open candidates one by one and judge every header in the reading pane (headerVerdicts, a copy of the
// pane). Each candidate is opened once and scored; then the newest is reopened and its Reply pressed.
var personName = ""
var lastPane: Node? = nil, lastReason: String? = nil
var rejected: [String] = []
func shownMessage() -> (header: Header, table: Table)? {
  let froms = byId(window, "messageHeaderFromContent")
  guard let first = froms.first else { note("   no sender line in the reading pane yet"); return nil }
  // The copy starts 7 boxes above the first sender line, high enough for every header's own box.
  var base = first
  for _ in 0..<7 { if let p = parent(base) { base = p } }
  var climbs = 0
  while byId(base, "messageHeaderFromContent").count < froms.count, climbs < 4, let p = parent(base) { base = p; climbs += 1 }
  let table = Table()
  let pane = snapshot(base, table, limit: 4000)
  let judged = headerVerdicts(pane, sender: sender, me: me, target: target, now: Date(), background: background)
  if personName.isEmpty { personName = judged.personName }
  for h in judged.headers { note("   header: from=\(h.from.prefix(40)) own=\(h.own) ok=\(h.ok) reason=\(h.reason) stamp=[\(h.stamp)]") }
  lastPane = pane
  lastReason = judged.headers.first?.reason
  guard let pick = chosen(judged.headers) else { return nil }
  return (pick, table)
}
var picks: [Header?] = []
var keys: [String] = []
var groupOf: [String: String] = [:]    // a judged email's conversation, to expand it again for the Reply
// Judges every listed email not judged yet, at most 8 in all.
func judgeListed(_ group: String?) {
  while keys.count < 8 {
    guard let row = candidateRows().first(where: { !keys.contains(rowKey(rowText($0))) }) else { return }
    let key = rowKey(rowText(row))
    note("row \(keys.count): \(key.prefix(90))\(group.map { " (in \($0.prefix(30)))" } ?? "")")
    AXUIElementSetAttributeValue(row, kAXSelectedAttribute as CFString, kCFBooleanTrue)
    lastPane = nil; lastReason = nil
    let shown = waitFor(5, shownMessage)
    if let pane = lastPane { save("pane-\(keys.count).json", encode(Snap(root: pane))) }
    if shown == nil { rejected.append(lastReason ?? "no-header") }
    picks.append(shown?.header); keys.append(key)
    if let g = group { groupOf[key] = g }
  }
}
judgeListed(conversationRows().first(where: isExpanded).map { rowKey(rowText($0)) })
for conversation in conversations where keys.count < 8 {
  expand(conversation)
  judgeListed(conversation)
}
facts["candidates_total"] = keys.count
facts["candidates_checked"] = keys.count
facts["candidates_verified"] = picks.compactMap { $0 }.count
facts["candidates_rejected"] = rejected.map { ["reason": $0] }
var shown: (header: Header, table: Table)? = nil
if let b = bestAcross(picks) {
  // Rows in one conversation can share a key (same subject and sender line), so the first row with the key is not
  // always the email judged best: 2026-10-17 the K-House reply went on the user's own Oct 6 email although K-House's
  // Oct 7 one won. Every row with the key is tried, and only the one showing the judged message (same sender line,
  // same time) is kept; none showing it is no-verified-match, never a reply on another email.
  let best = picks[b]!
  func listedRows() -> [AXUIElement] { candidateRows().filter { rowKey(rowText($0)) == keys[b] } }
  if listedRows().isEmpty, let g = groupOf[keys[b]] { expand(g) }
  for row in listedRows() {
    AXUIElementSetAttributeValue(row, kAXSelectedAttribute as CFString, kCFBooleanTrue)
    // The reading pane can lag the selection and show the email selected before; wait for this one, not the first pane.
    let isBest = { (s: (header: Header, table: Table)) in s.header.from == best.from && s.header.stamp == best.stamp }
    let seen = waitFor(3, { () -> (header: Header, table: Table)? in shownMessage().flatMap { isBest($0) ? $0 : nil } }) ?? shownMessage()
    let same = seen.map(isBest) ?? false
    note("   reselected \(keys[b].prefix(60)) | best own=\(best.own) [\(best.stamp)] | shown own=\(String(describing: seen?.header.own)) [\(seen?.header.stamp ?? "")] same=\(same)")
    if same { shown = seen; break }
  }
}
let ownMessage = shown?.header.own ?? false
if let h = shown?.header {
  var on: [String: Any] = ["from": h.from, "stamp": h.stamp, "own": h.own]
  if let w = h.when { let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; on["day"] = f.string(from: w) }
  facts["replied_on"] = on
}
step("verify")
// --decide-only: everything up to the choice of message and button, then stop. Nothing is pressed or opened.
if args.contains("--decide-only") {
  emit("decided", ownMessage ? "Would press Reply all on the user's own newest message to the person." : "Would press Reply on the person's newest message.", ["own": String(ownMessage), "row": shown == nil ? "none" : String(keys[bestAcross(picks)!].prefix(80))])
}
guard let verified = shown else {
  emit("no-verified-match", "Opened \(keys.count) email(s) with that subject; none was from \(sender) on the expected day.")
}
// On the user's own message, Reply would address the user; Reply all addresses the people the user wrote to.
let replyId = ownMessage ? "messageHeaderContextualControlsReplyAllButton" : "messageHeaderContextualControlsReplyButton"
let replyTitles = ownMessage ? ["Reply All", "Reply all"] : ["Reply"]
note("   replying on \(ownMessage ? "the user's own message: Reply all" : "the person's message: Reply")")

// --- 4. press that message's Reply, and wait for a NEW reply window
// Background mode: the new Outlook exposes the Reply button (and enables Message > Reply) only while its window
// is active (measured 2026-10-03). So Outlook comes forward for the press alone, and the front is handed back
// right after; the draft goes in through accessibility, never as keystrokes.
func buttonOf(_ s: (header: Header, table: Table)) -> AXUIElement? {
  (ownMessage ? s.header.replyAllPath : s.header.replyPath).flatMap { s.table.map[$0] }
}
var pressTarget = buttonOf(verified)
var how = "press"
if !background {
  guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == OUTLOOK else { emit("not-front", "Outlook lost the front before Reply; stopped.") }
  AXUIElementPerformAction(window, kAXRaiseAction as CFString)
}
if background {
  if !previousFront.isEmpty && previousFront != OUTLOOK { onExit = { returnFront() } }
  openApp(OUTLOOK)
  guard waitFor(5, { NSWorkspace.shared.frontmostApplication?.bundleIdentifier == OUTLOOK ? true : nil }) != nil else {
    emit("not-front", "Outlook could not come forward for the Reply press; nothing was pressed.")
  }
  AXUIElementPerformAction(window, kAXRaiseAction as CFString)
  // A narrow reading pane folds Reply into the header's overflow menu (measured on Jamie's thread), so the menu
  // bar's Message > Reply is the layout-proof route: enabled once Outlook is in front with the email selected.
  func menuReply() -> AXUIElement? {
    guard let mb = attr(root, kAXMenuBarAttribute) else { return nil }
    for top in children(mb as! AXUIElement) where text(top, kAXTitleAttribute) == "Message" {
      for menu in children(top) {
        for item in children(menu) where replyTitles.contains(text(item, kAXTitleAttribute)) {
          return (attr(item, kAXEnabledAttribute) as? Bool) == true ? item : nil
        }
      }
    }
    return nil
  }
  guard let fresh = waitFor(4, { () -> AXUIElement? in
    guard let s = shownMessage() else { return nil }
    if let b = buttonOf(s) { how = "press"; return b }
    if let m = menuReply() { how = "menu"; return m }
    return nil
  }) else { emit("no-verified-match", "The verified email's Reply button did not appear once Outlook was in front.") }
  pressTarget = fresh
}
guard let pressTarget = pressTarget else { emit("no-verified-match", "The verified email showed no Reply button.") }
// Counted just before the press, not at the start: opening a candidate that is a deleted draft shows it as an
// editable reply with its own To field (Jess's thread, 2026-10-04), and that field is not the reply this run opens.
let toBefore = Set(toFields().map { Int(CFHash($0)) })
let windowsBefore = ((attr(root, kAXWindowsAttribute) as? [AXUIElement]) ?? []).count
var newTo: AXUIElement? = nil
func newCompose() -> AXUIElement? {
  guard let to = toFields().first(where: { !toBefore.contains(Int(CFHash($0))) }) else { return nil }
  newTo = to
  var box = parent(to)
  for _ in 0..<8 {
    guard let b = box else { return nil }
    if !find(b, limit: 4000, { text($0, kAXRoleAttribute) == "AXTextArea" && editable($0) && !text($0, kAXValueAttribute).hasPrefix("Try advanced search") }).isEmpty { return b }
    box = parent(b)
  }
  return nil
}
let pressed = AXUIElementPerformAction(pressTarget, kAXPressAction as CFString)
var compose = waitFor(5, newCompose)
if compose == nil && background { emit("background-reply-did-not-open", "Found and verified the email; Outlook ignored the Reply press while in the background.") }
if compose == nil {
  // The press can be ignored when the mail window is not key. Outlook's own shortcut, Cmd+R, replies to the
  // selected message; the verified message is selected and Outlook is in front, checked again here.
  guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == OUTLOOK else { emit("not-front", "Outlook lost the front before Reply; stopped.") }
  let src = CGEventSource(stateID: .combinedSessionState)
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: src, virtualKey: 15, keyDown: down)   // 15 = R
    e?.flags = .maskCommand; e?.post(tap: .cghidEventTap)
  }
  compose = waitFor(6, newCompose)
  how = "Cmd+R"
}
facts["how"] = how
guard let compose = compose else {
  emit("reply-did-not-open", "Found and verified the email, but Outlook opened no reply window (press result \(pressed.rawValue), then Cmd+R).")
}
step("reply")

// --- 5. audit the reply before anything is pasted: To, Cc, subject, windows (auditBeforePaste, on a copy)
let preTable = Table()
var pre = Snap(root: snapshot(compose, preTable), toPath: pathOf(newTo, preTable), focusedPath: pathOf(attr(root, kAXFocusedUIElementAttribute).map { $0 as! AXUIElement }, preTable))
pre.bodyPath = pickBody(pre)
save("compose-pre.json", encode(pre))
var audit = auditBeforePaste(pre, expect, personName: personName)
let toAfter = toFields().count, windowsAfter = ((attr(root, kAXWindowsAttribute) as? [AXUIElement]) ?? []).count
audit["to_fields_before"] = toBefore.count; audit["to_fields_after"] = toAfter
audit["windows_before"] = windowsBefore; audit["windows_after"] = windowsAfter
if toAfter > toBefore.count + 1 || windowsAfter > windowsBefore + 1 {
  finding("audit-extra-window", "\(toAfter - toBefore.count) reply windows opened, 1 expected; close the extra one.", stop: false)
}
facts["audit"] = audit
// The reply's own window once it is popped out (step 8): from then on that window is the reply that must still be open.
var poppedWindow: AXUIElement? = nil
// Where the front went and whether the reply is still open can only be read after the front is handed back.
atExit = {
  let want = background && !previousFront.isEmpty && previousFront != OUTLOOK ? previousFront : OUTLOOK
  let front = waitFor(2) { NSWorkspace.shared.frontmostApplication?.bundleIdentifier == want ? want : nil } ?? (NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "")
  audit["front_at_exit"] = front
  audit["compose_still_open"] = poppedWindow.map { attr($0, kAXRoleAttribute) != nil } ?? newTo.map { attr($0, kAXRoleAttribute) != nil } ?? false
  if front != want { finding("audit-front-not-returned", "Focus stayed in \(front == OUTLOOK ? "Outlook" : front) instead of going back to where you were.", stop: false) }
  if audit["compose_still_open"] as? Bool == false { finding("audit-compose-vanished", "The reply window closed on its own; check Sent and Drafts.", stop: false) }
  facts["audit"] = audit
}
note("   To: \(audit["to_tokens"] ?? []) Cc: \(audit["cc_tokens"] ?? []) subject: \(audit["subject"] ?? "")")
facts["pasted"] = false
if let stop = findings.first(where: { $0["severity"] == "stop" }) {
  emit(stop["code"]!, "\(stop["message"]!) Close it; it was not sent.", ["opened_by": how, "to_row": (audit["to_tokens"] as? [String] ?? []).prefix(6).joined(separator: " | ")])
}
if args.contains("--stop-after-reply") { emit("reply-open-no-paste", "Reply opened (\(how)) addressed to \(sender); stopped before pasting (inspection run).") }
step("audit_pre")

// --- 6. focus the reply body and paste the draft
let pasteboard = NSPasteboard.general
let bodyArea = pre.bodyPath.flatMap { preTable.map[$0] }
let bodyBefore = bodyArea.map { text($0, kAXValueAttribute) } ?? ""
let firstLine = body.split(separator: "\n").first.map { String($0).trimmingCharacters(in: .whitespaces) } ?? ""
// Background mode shares the paste below: Outlook is already forward for the Reply press, and text inserted
// through accessibility does not persist in its editor (measured on Jamie's thread: it read back, then vanished).
if let area = bodyArea { AXUIElementSetAttributeValue(area, kAXFocusedAttribute as CFString, kCFBooleanTrue) }
let focusedOK = waitFor(3) { () -> Bool? in
  guard let area = bodyArea, let f = attr(root, kAXFocusedUIElementAttribute) else { return nil }
  return CFEqual(f as! AXUIElement, area) ? true : nil
} != nil
guard focusedOK, NSWorkspace.shared.frontmostApplication?.bundleIdentifier == OUTLOOK else {
  pasteboard.clearContents(); pasteboard.setString(body, forType: .string)
  emit("reply-open-draft-on-clipboard", "The reply is open and addressed to \(sender), but its text box did not take focus. The draft is on the clipboard: click into the reply and press Cmd+V.", ["opened_by": how])
}
// Save the user's clipboard, paste, put it back.
let saved: [[NSPasteboard.PasteboardType: Data]] = (pasteboard.pasteboardItems ?? []).map { item in
  var copy: [NSPasteboard.PasteboardType: Data] = [:]
  for t in item.types { if let d = item.data(forType: t) { copy[t] = d } }
  return copy
}
pasteboard.clearContents(); pasteboard.setString(body + "\n", forType: .string)
let src = CGEventSource(stateID: .combinedSessionState)
for down in [true, false] {
  let e = CGEvent(keyboardEventSource: src, virtualKey: 9, keyDown: down)   // 9 = V
  e?.flags = .maskCommand
  e?.post(tap: .cghidEventTap)
}
// Wait until the draft shows in the body, then keep reading for 0.4 s more: an immediate read-back was once fooled
// by text that later vanished, so a line that disappears again fails the check below.
_ = waitFor(2) { () -> Bool? in guard let area = bodyArea else { return nil }; return text(area, kAXValueAttribute).contains(firstLine) ? true : nil }
usleep(400_000)
pasteboard.clearContents()
for item in saved {
  let restored = NSPasteboardItem()
  for (t, d) in item { restored.setData(d, forType: t) }
  pasteboard.writeObjects([restored])
}
// Verify the paste landed in the reply body: read it back.
let landed = waitFor(3) { () -> Bool? in
  guard let area = bodyArea else { return nil }
  return text(area, kAXValueAttribute).contains(firstLine) ? true : nil
} != nil
step("paste")
guard landed else {
  pasteboard.clearContents(); pasteboard.setString(body, forType: .string)
  emit("reply-open-draft-on-clipboard", "The reply is open and addressed to \(sender), but the draft did not show up in its body. The draft is on the clipboard: click into the reply and press Cmd+V.", ["opened_by": how])
}
facts["pasted"] = true

// --- 7. audit the body after the paste: draft on top and once, one signature, one closing line
let postTable = Table()
var post = Snap(root: snapshot(compose, postTable), toPath: pathOf(newTo, postTable))
post.bodyPath = pathOf(bodyArea, postTable)
save("compose-post.json", encode(post))
for (k, v) in auditAfterPaste(before: bodyBefore, after: bodyArea.map { text($0, kAXValueAttribute) } ?? "", draftFirstLine: firstLine) { audit[k] = v }
facts["audit"] = audit
step("audit_post")

// --- 8. pop the checked reply out into its own window, as double-clicking a draft does (Gio, 2026-10-10: "lets make
// the default the popout window like when you double click a draft it becomes its own window"). Only after the paste
// is read back and audited, so the window holds a checked draft. The button is the compose's own "Continue message in
// a separate window" (fullMessageComposeButton, read from compose-post.json of a live reply). --inline skips this.
var placedIn = "in Outlook's reading pane"
if !args.contains("--inline") {
  let before = (attr(root, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  if let pop = byId(compose, "fullMessageComposeButton").first {
    AXUIElementPerformAction(pop, kAXPressAction as CFString)
    // The new window counts only when it shows the draft's first line: a window that opened empty is not the reply.
    poppedWindow = waitFor(6) { () -> AXUIElement? in
      let windows = (attr(root, kAXWindowsAttribute) as? [AXUIElement]) ?? []
      // Only a window that was not there before the press: the main window still holds the inline reply for a moment.
      let fresh = windows.filter { w in !before.contains { CFEqual($0, w) } }
      return fresh.first { w in !find(w, max: 1) { text($0, kAXValueAttribute).contains(firstLine) }.isEmpty }
    }
    let popped = poppedWindow != nil
    facts["popped_out"] = popped
    if popped { placedIn = "in its own Outlook window" } else { facts["pop_out"] = "pressed, but no window with the draft appeared" }
  } else {
    facts["popped_out"] = false
    facts["pop_out"] = "no separate-window button on this reply"
  }
  step("pop_out")
}
emit("replied", "Reply opened (\(how)) on the email to or from \(sender) \(placedIn), and the draft is in its body, checked. Nothing was sent.", ["opened_by": how])
