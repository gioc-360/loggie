// hikyaku's Outlook invite helper. Loggie opens New Outlook's own new-event window with a link (title, people, start);
// the link cannot carry an end time, a body or a room, so this finishes the invite through the macOS accessibility
// layer, the way outlook.swift finishes a reply:
//   find the event window by its subject -> set the end time from Outlook's own menu -> turn Teams off for a room
//   meeting -> type the building in Location, read each room's availability for this exact slot,
//   pick the first Available room on the wanted floors -> paste the body -> read the window back -> STOP.
// It never presses Send. The invite stays open for the user, who reads it and sends it.
// Elements were mapped read-only on 2026-10-08: the window title "<subject> • Calendar • <account>", the "End time"
// pop-up (a menuWindow of "HH:MM (About N minutes)" cells), the "Teams meeting" checkhouse, the body AXTextArea under
// the "Editor" group, the "Add a location" field and its "Locations" pop-up (one AXCell per room: name, then
// "Available" or "Busy" for the event's own time).
//
//   hikyaku-outlook-event fill --subject S --end HH:MM [--nearest] [--body-file f.html] [--room-query Breazzano] [--floors 23]
//                              [--location "Maplewood" [--near Ithaca]] [--repeat daily|weekly|monthly|yearly]
//                              [--teams on|off] [--pace slow]
//   hikyaku-outlook-event discard --subject "Loggie test ..."   (tests only: closes an unsent test invite)
//   hikyaku-outlook-event check
// Fast by waiting on what Outlook shows, never on the clock (2026-10-09: a fixed pause after every step cost 3 to 5 s;
// the window itself opens in about 0.7 s and one scan of its tree takes about 70 ms). Every run reports "steps", the
// milliseconds each step took. --pace slow adds the old pauses back for screen recordings.
// --nearest: Outlook here ends meetings early, so its end menu offers 14:25, 14:50, 15:20 from 14:00 (seen 2026-10-09);
// with --nearest the closest offered end is chosen (the earlier one on a tie) and reported as end_set.
// --location types a place that is not a bookable room and chooses Outlook's top suggestion, or the first one whose
// address names --near. --repeat chooses from the Recurrence picker, which opens only to a real click.
// Prints one JSON object: {"status": ..., "detail": ..., and what the run saw}. --pace slow waits between steps so a
// screen recording can follow them; the steps and checks are the same.
import Cocoa
import ApplicationServices

let OUTLOOK = "com.microsoft.Outlook"
let started = Date()
var facts: [String: Any] = [:]
var stepTimes: [String: Int] = [:]
var mark = Date()
func step(_ name: String) { stepTimes[name] = Int(Date().timeIntervalSince(mark) * 1000); mark = Date() }

func emit(_ status: String, _ detail: String) -> Never {
  var out = facts
  out["status"] = status; out["detail"] = detail
  if !stepTimes.isEmpty { out["steps"] = stepTimes }
  out["ms"] = Int(Date().timeIntervalSince(started) * 1000)
  let data = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
  exit(status == "ready" || status == "ok" ? 0 : 1)
}

let argv = CommandLine.arguments
func arg(_ name: String) -> String? { argv.firstIndex(of: name).flatMap { $0 + 1 < argv.count ? argv[$0 + 1] : nil } }
let command = argv.count > 1 ? argv[1] : ""
let slow = arg("--pace") == "slow"
func pause(_ seconds: Double) { usleep(useconds_t((slow ? seconds * 2.5 : seconds) * 1_000_000)) }
// A beat only a screen recording needs: nothing at normal pace.
func beat(_ seconds: Double) { if slow { usleep(useconds_t(seconds * 2.5 * 1_000_000)) } }

guard AXIsProcessTrusted() else { emit("needs_accessibility", "Loggie needs Accessibility to finish the invite in Outlook.") }
guard let outlook = NSRunningApplication.runningApplications(withBundleIdentifier: OUTLOOK).first else { emit("outlook_not_running", "Open Outlook, then try again.") }
let app = AXUIElementCreateApplication(outlook.processIdentifier)
if command == "check" { emit("ok", "Accessibility allowed and Outlook running.") }
if command == "discard" {
  // Tests only: close an unsent invite whose subject starts with "Loggie test", with Outlook's own Discard button.
  guard let subject = arg("--subject"), subject.hasPrefix("Loggie test") else { emit("usage", "discard only closes a test invite: --subject \"Loggie test ...\"") }
  let w = (attr(app, kAXWindowsAttribute) as? [AXUIElement] ?? []).first { (attr($0, kAXTitleAttribute) as? String ?? "").hasPrefix(subject) }
  guard let w else { emit("ok", "No test invite open.") }
  func find(_ e: AXUIElement, _ d: Int) -> AXUIElement? {
    if d > 12 { return nil }
    if (attr(e, kAXRoleAttribute) as? String) == "AXButton" && (((attr(e, kAXTitleAttribute) as? String) ?? "").hasPrefix("Discard") || ((attr(e, kAXDescriptionAttribute) as? String) ?? "").hasPrefix("Discard")) { return e }
    for k in (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { if let f = find(k, d + 1) { return f } }
    return nil
  }
  // A window in the background ignores the press: bring it forward first.
  outlook.activate(); AXUIElementPerformAction(w, kAXRaiseAction as CFString); AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue); usleep(300_000)
  // An open sheet (Recurrence) blocks the window: cancel it first.
  for k in (attr(w, kAXChildrenAttribute) as? [AXUIElement]) ?? [] where (attr(k, kAXRoleAttribute) as? String) == "AXSheet" {
    func cancel(_ e: AXUIElement) -> Bool {
      if (attr(e, kAXRoleAttribute) as? String) == "AXButton" && ((attr(e, kAXTitleAttribute) as? String) ?? (attr(e, kAXDescriptionAttribute) as? String) ?? "").hasPrefix("Cancel") { return AXUIElementPerformAction(e, kAXPressAction as CFString) == .success }
      return ((attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? []).contains { cancel($0) }
    }
    _ = cancel(k); usleep(400_000)
  }
  guard let b = find(w, 0), AXUIElementPerformAction(b, kAXPressAction as CFString) == .success else { emit("no_discard", "Could not find Discard.") }
  // Read back: the window must be gone, or the run says so.
  for _ in 0..<30 { usleep(100_000); if !((attr(app, kAXWindowsAttribute) as? [AXUIElement] ?? []).contains { (attr($0, kAXTitleAttribute) as? String ?? "").hasPrefix(subject) }) { emit("ok", "Test invite discarded.") } }
  emit("still_open", "Pressed Discard, but the test invite is still open.")
}
guard command == "fill", let subject = arg("--subject"), let end = arg("--end") else {
  emit("usage", "hikyaku-outlook-event fill --subject S --end HH:MM [--body-file f] [--room-query q] [--floors 23] [--teams on|off]")
}

// --- reading the tree
func attr(_ e: AXUIElement, _ a: String) -> AnyObject? { var v: AnyObject?; AXUIElementCopyAttributeValue(e, a as CFString, &v); return v }
func text(_ e: AXUIElement, _ a: String) -> String { (attr(e, a) as? String) ?? "" }
func role(_ e: AXUIElement) -> String { text(e, kAXRoleAttribute) }
func kids(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func label(_ e: AXUIElement) -> String { [text(e, kAXTitleAttribute), text(e, kAXDescriptionAttribute), text(e, kAXValueAttribute)].joined(separator: " | ") }
func all(_ root: AXUIElement, depth: Int = 0, _ match: (AXUIElement) -> Bool) -> [AXUIElement] {
  if depth > 40 { return [] }
  var found = match(root) ? [root] : []
  for child in kids(root) { found += all(child, depth: depth + 1, match) }
  return found
}
func first(_ root: AXUIElement, _ r: String, _ words: String) -> AXUIElement? { all(root) { role($0) == r && label($0).contains(words) }.first }
func windows() -> [AXUIElement] { (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? [] }
func window(titled prefix: String) -> AXUIElement? { windows().first { text($0, kAXTitleAttribute).hasPrefix(prefix) } }
func waitFor<T>(_ seconds: Double, _ probe: () -> T?) -> T? {
  let until = Date().addingTimeInterval(seconds)
  while Date() < until { if let found = probe() { return found }; usleep(50_000) }
  return nil
}
func click(_ e: AXUIElement) {
  // A real mouse click at the element's centre: Outlook's Recurrence picker ignores the accessibility press.
  var p = CGPoint.zero, z = CGSize.zero
  if let v = attr(e, kAXPositionAttribute) { AXValueGetValue(v as! AXValue, .cgPoint, &p) }
  if let v = attr(e, kAXSizeAttribute) { AXValueGetValue(v as! AXValue, .cgSize, &z) }
  let c = CGPoint(x: p.x + z.width / 2, y: p.y + z.height / 2)
  for t in [CGEventType.leftMouseDown, .leftMouseUp] { CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: c, mouseButton: .left)?.post(tap: .cghidEventTap); usleep(40_000) }
}
func minutes(_ hhmm: String) -> Int? { let p = hhmm.split(separator: ":").compactMap { Int($0) }; return p.count == 2 ? p[0] * 60 + p[1] : nil }
func staticOrValue(_ e: AXUIElement) -> String { text(e, kAXValueAttribute) + " " + staticTexts(e).joined(separator: " ") }
func staticTexts(_ e: AXUIElement) -> [String] { all(e) { role($0) == "AXStaticText" }.map { text($0, kAXValueAttribute) } }

// --- acting
func press(_ e: AXUIElement) -> Bool { AXUIElementPerformAction(e, kAXPressAction as CFString) == .success }
func focus(_ e: AXUIElement) { AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue) }
let keys = CGEventSource(stateID: .combinedSessionState)
func key(_ code: CGKeyCode, _ flags: CGEventFlags = []) {
  for down in [true, false] { let e = CGEvent(keyboardEventSource: keys, virtualKey: code, keyDown: down)!; e.flags = flags; e.post(tap: .cghidEventTap) }
  usleep(60_000)
}
func type(_ words: String) {
  for unit in words.utf16 {
    var u = unit
    for down in [true, false] { let e = CGEvent(keyboardEventSource: keys, virtualKey: 0, keyDown: down)!; e.keyboardSetUnicodeString(stringLength: 1, unicodeString: &u); e.post(tap: .cghidEventTap) }
    usleep(slow ? 70_000 : 25_000)
  }
}

// 1. The window Loggie's link opened.
guard let win = waitFor(10, { window(titled: subject) }) else { emit("no_event_window", "No Outlook event window titled \"\(subject)\". Nothing was changed.") }
AXUIElementPerformAction(win, kAXRaiseAction as CFString)
outlook.activate()
beat(0.6)
_ = waitFor(3) { first(win, "AXTextField", "Subject").map({ text($0, kAXValueAttribute) }) == subject ? true : nil }
step("window")
guard first(win, "AXTextField", "Subject").map({ text($0, kAXValueAttribute) }) == subject else { emit("wrong_window", "The event window's subject is not \"\(subject)\". Nothing was changed.") }

// 2. End time, from Outlook's own menu (the time field takes no typing).
guard let endMenu = first(win, "AXPopUpButton", "End time"), press(endMenu) else { emit("no_end_time", "Could not open the end time menu.") }
guard let menu = waitFor(3, { windows().first { text($0, kAXTitleAttribute) == "menuWindow" } }) else { emit("no_end_time", "The end time menu did not open.") }
beat(0.4)
let cells = waitFor(2) { () -> [AXUIElement]? in let c = all(menu, { role($0) == "AXCell" && minutes(String(text($0, kAXDescriptionAttribute).prefix(5))) != nil }); return c.isEmpty ? nil : c } ?? []
let offered = cells.map { String(text($0, kAXDescriptionAttribute).prefix(5)) }
facts["end_offered"] = Array(offered.prefix(6))
var endSet = end
if !offered.contains(end), argv.contains("--nearest"), let want = minutes(end) {
  // the closest offered end, the earlier one on a tie; never the start itself (About 0 minutes)
  let usable = offered.dropFirst().compactMap { o in minutes(o).map { (o, abs($0 - want), $0) } }
  if let best = usable.min(by: { $0.1 != $1.1 ? $0.1 < $1.1 : $0.2 < $1.2 }) { endSet = best.0 }
}
facts["end_set"] = endSet
// by the time itself: with "Shorten duration" off a cell can read "14:30" with nothing after it (2026-10-29)
guard let cell = cells.first(where: { String(text($0, kAXDescriptionAttribute).prefix(5)) == endSet }) else {
  key(53); emit("end_time_not_offered", "Outlook does not offer \(end) as an end time for this start (it offers \(offered.prefix(4).joined(separator: ", "))).")
}
if let row = attr(cell, kAXParentAttribute) { AXUIElementSetAttributeValue(row as! AXUIElement, kAXSelectedAttribute as CFString, kCFBooleanTrue) }
_ = press(cell)
beat(0.6)
let slotNow = { all(win) { text($0, "AXIdentifier") == "Placeholder tile" }.first.map { text($0, kAXValueAttribute) } ?? "" }
let slot = waitFor(3) { slotNow().contains("- \(endSet),") ? slotNow() : nil } ?? slotNow()
facts["slot"] = slot
guard slot.contains("- \(endSet),") else { emit("end_time_not_set", "The end time did not change to \(endSet) (Outlook shows \"\(slot)\").") }
step("end_time")

// 2b. Find a time that works for everyone (--try "YYYY-MM-DD HH:MM,..." in the order to test). Outlook judges each
// slot for everyone on the invite and says so on the slot line: "Everyone is available", "You are unavailable",
// "1 person is unavailable" (Cornell's Exchange knows their calendars). When the asked time is free it stays and
// nothing else is tried. Otherwise the candidates (free on the user's own calendar, from Loggie) are tried in order
// until --want of them are free for everyone; the invite is left on the first, and the others are reported.
// "Next day" in the mini schedule moves the event itself a day (seen 2026-10-09); the Start time menu offers every
// half hour as "HH:MM". Outlook's own suggestion buttons appear only when the window first opens, at its default
// 25 minutes, so they are not used.
// Moving the invite in time, for the time search (2b) and the room search (4).
let everyone = { (slot: String) -> Bool in slot.contains("Everyone is available") || slot.contains("You are available") }
let dayFormat = DateFormatter(); dayFormat.locale = Locale(identifier: "en_US"); dayFormat.dateFormat = "EEEE, MMMM d, yyyy"
let isoDay = DateFormatter(); isoDay.locale = Locale(identifier: "en_US_POSIX"); isoDay.dateFormat = "yyyy-MM-dd"
func shownDay() -> String? {
  for e in all(win, { role($0) == "AXUnknown" && text($0, kAXDescriptionAttribute).range(of: #"^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}, \d{4}$"#, options: .regularExpression) != nil }) {
    if let d = dayFormat.date(from: text(e, kAXDescriptionAttribute)) { return isoDay.string(from: d) }
  }
  return nil
}
func shift(to day: String) -> Bool {
  guard let now = shownDay(), let a = isoDay.date(from: now), let b = isoDay.date(from: day) else { return false }
  let days = Calendar.current.dateComponents([.day], from: a, to: b).day ?? 0
  guard days != 0 else { return true }
  let id = days > 0 ? "MiniSchedulingAssistantNextDateButton" : "MiniSchedulingAssistantPreviousDateButton"
  for _ in 0..<abs(days) {
    let before = shownDay()
    guard let button = all(win, { text($0, "AXIdentifier") == id }).first, press(button) else { return false }
    guard waitFor(3, { shownDay() != before ? true : nil }) != nil else { return false }
  }
  return shownDay() == day
}
func setStart(_ hhmm: String) -> Bool {
  if slotNow().hasPrefix("\(hhmm) - ") { return true }
  guard let pop = first(win, "AXPopUpButton", "Start time"), press(pop) else { return false }
  guard let menu = waitFor(3, { windows().first { text($0, kAXTitleAttribute) == "menuWindow" } }) else { return false }
  guard let cell = waitFor(2, { all(menu, { role($0) == "AXCell" && text($0, kAXDescriptionAttribute) == hhmm }).first }) else { key(53); return false }
  // Select the row and press the cell together, as the end time does (waiting for the menu to close first cost 0.6 s).
  if let row = attr(cell, kAXParentAttribute) { AXUIElementSetAttributeValue(row as! AXUIElement, kAXSelectedAttribute as CFString, kCFBooleanTrue) }
  _ = press(cell)
  return waitFor(3) { slotNow().hasPrefix("\(hhmm) - ") ? true : nil } != nil
}
// The slot line is rewritten when the time moves; its verdict can land a beat later, so read it until it holds.
func verdict() -> String {
  var last = slotNow()
  for _ in 0..<6 { usleep(120_000); let now = slotNow(); if now == last { return now }; last = now }
  return last
}
// Times not yet tried, for the room search to fall back on.
var laterTries: [String] = (arg("--try") ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
if let tries = arg("--try") {
  let want = Int(arg("--want") ?? "3") ?? 3
  let asked = "\(shownDay() ?? "?") \(String(slotNow().prefix(5)))"
  var found: [String] = []
  var probes: [String] = []
  let askedFree = everyone(verdict())
  if askedFree { found.append(asked) }
  if !askedFree || argv.contains("--extras") {
    if !askedFree { probes.append("\(asked): \(slotNow())") }
    // The first free time is the one that matters; the extras are a courtesy and stop at 2 s of searching, so listing
    // them never pushes the invite past the 10 s bar (2026-10-09: seven tries across four days took 9.6 s).
    let searchStart = Date()
    for candidate in tries.split(separator: ",").map({ $0.trimmingCharacters(in: .whitespaces) }) where found.count < want && probes.count < 14 && (found.isEmpty || Date().timeIntervalSince(searchStart) < 2.0) {
      laterTries.removeAll { $0 == candidate }
      let parts = candidate.split(separator: " ").map(String.init)
      let t0 = Date()
      guard parts.count == 2, shift(to: parts[0]) else { probes.append("\(candidate): could not move there"); continue }
      let t1 = Date()
      guard setStart(parts[1]) else { probes.append("\(candidate): could not move there"); continue }
      let t2 = Date()
      let line = verdict()
      let ms = { (a: Date, b: Date) in Int(b.timeIntervalSince(a) * 1000) }
      probes.append("\(candidate): \(line) [day \(ms(t0, t1)) ms, start \(ms(t1, t2)) ms, verdict \(ms(t2, Date())) ms]")
      if everyone(line) { found.append(candidate) }
    }
  }
  facts["probes"] = probes
  guard let pick = found.first else { emit("no_time_found", "No time in the hours searched works for everyone (\(probes.count) tried). The invite is on the last one tried; pick a time in Outlook.") }
  let pickParts = pick.split(separator: " ").map(String.init)
  guard shift(to: pickParts[0]), setStart(pickParts[1]), everyone(verdict()) else { emit("time_not_set", "Found \(pick) free for everyone but could not move the invite back to it.") }
  facts["time_found"] = pick
  facts["time_asked_free"] = askedFree && pick == asked
  facts["also_free"] = Array(found.dropFirst())
  facts["slot"] = slotNow()
  step("find_time")
}

// 3. A room meeting is not a Teams meeting.
if let teams = first(win, "AXCheckBox", "Teams meeting") {
  let on = (attr(teams, kAXValueAttribute) as? Int ?? 0) == 1
  let wanted = arg("--teams") == "on"
  if on != wanted { _ = press(teams); beat(0.5); _ = waitFor(2) { ((attr(teams, kAXValueAttribute) as? Int ?? 0) == 1) == wanted ? true : nil } }
  facts["teams"] = (attr(teams, kAXValueAttribute) as? Int ?? 0) == 1 ? "on" : "off"
}
step("teams")

// 3b. Repeat, from Outlook's Recurrence picker: "Repeat daily", "Repeat weekly", "Repeat monthly" or "Repeat yearly".
// The picker opens only to a real click. A plain repeat is chosen by selecting its row, then Outlook's Recurrence
// sheet needs Save. A custom repeat (--every N, --on Tue,Thu, --until YYYY-MM-DD, --times N, --no-end) opens the same
// sheet through "Custom" (or "Edit" once a repeat is set): its menus open to a click and choose with a press, the
// end date is a date field that takes a value (it stuck when reopened, 2026-10-09), and "after" shows an
// "occurrences" box. Every field is read back before Save.
let custom = ["--every", "--on", "--until", "--times"].contains { argv.contains($0) } || argv.contains("--no-end")
if let every = arg("--repeat") {
  guard ["daily", "weekly", "monthly", "yearly"].contains(every) else { emit("usage", "--repeat takes daily, weekly, monthly or yearly.") }
  guard let picker = first(win, "AXPopUpButton", "Recurrence") else { emit("no_repeat", "Could not find the Recurrence picker.") }
  // Choose one item from a menu that just opened, the way that menu takes it: select its row, else press it, else click.
  func choose(_ cell: AXUIElement) {
    if let row = attr(cell, kAXParentAttribute) { AXUIElementSetAttributeValue(row as! AXUIElement, kAXSelectedAttribute as CFString, kCFBooleanTrue) }
    let closed = { windows().contains { text($0, kAXTitleAttribute) == "menuWindow" } ? nil : true }
    if waitFor(0.5, closed) != nil { return }
    _ = press(cell)
    if waitFor(0.5, closed) != nil { return }
    click(cell); _ = waitFor(1, closed)
  }
  func openMenu(_ popup: AXUIElement) -> AXUIElement? {
    outlook.activate(); AXUIElementPerformAction(win, kAXRaiseAction as CFString)
    click(popup)
    return waitFor(3, { windows().first { text($0, kAXTitleAttribute) == "menuWindow" } })
  }
  guard let list = openMenu(picker) else { emit("no_repeat", "The Recurrence picker did not open.") }
  beat(0.4)
  let wanted = custom ? ["Custom", "Edit"] : ["Repeat \(every)"]
  guard let choice = waitFor(2, { all(list) { cell in role(cell) == "AXCell" && wanted.contains { text(cell, kAXDescriptionAttribute).hasSuffix($0) } }.first }) else {
    key(53); emit("no_repeat", "Outlook does not offer \"\(wanted[0])\".")
  }
  choose(choice)
  guard let sheet = waitFor(3, { kids(win).first { role($0) == "AXSheet" } }) else { emit("repeat_not_set", "Outlook's Recurrence sheet did not open.") }
  beat(0.6)
  let ruleText = { all(sheet) { role($0) == "AXStaticText" && text($0, kAXValueAttribute).hasPrefix("Occurs") }.first.map { text($0, kAXValueAttribute) } ?? "" }
  if custom {
    let popups = { kids(sheet).filter { role($0) == "AXPopUpButton" } }   // in order: Repeat, Every, End
    func pick(_ popup: AXUIElement, _ option: String) -> Bool {
      if text(popup, kAXValueAttribute) == option { return true }
      guard let menu = openMenu(popup), let cell = waitFor(2, { all(menu) { role($0) == "AXCell" && (text($0, kAXDescriptionAttribute) == option || text($0, kAXDescriptionAttribute).hasSuffix(", \(option)")) }.first }) else { key(53); return false }
      choose(cell)
      return waitFor(2) { text(popup, kAXValueAttribute) == option ? true : nil } != nil
    }
    let kind = ["daily": "Daily", "weekly": "Weekly", "monthly": "Monthly", "yearly": "Yearly"][every]!
    guard let repeatPop = popups().first, pick(repeatPop, kind) else { emit("repeat_not_set", "Could not set the repeat to \(kind).") }
    if let n = arg("--every") {
      guard popups().count >= 2, pick(popups()[1], n) else { emit("repeat_not_set", "Outlook does not offer every \(n).") }
    }
    if let days = arg("--on") {
      let wantDays = Set(days.split(separator: ",").map { String($0).prefix(3).lowercased() })
      for b in kids(sheet) where role(b) == "AXButton" {
        // The day's name and its state are in the button's description ("Tuesday, pressed"), not its title.
        let name = text(b, kAXDescriptionAttribute), isDay = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].contains(String(name.prefix(3)).lowercased())
        guard isDay else { continue }
        let on = name.hasSuffix(", pressed"), want = wantDays.contains(String(name.prefix(3)).lowercased())
        if on != want { _ = press(b); _ = waitFor(1) { text(b, kAXDescriptionAttribute).hasSuffix(", pressed") == want ? true : nil } }
      }
      let pressed = kids(sheet).filter { role($0) == "AXButton" && text($0, kAXDescriptionAttribute).hasSuffix(", pressed") }.map { String(text($0, kAXDescriptionAttribute).prefix(3)).lowercased() }
      guard Set(pressed) == wantDays else { emit("repeat_not_set", "The weekdays read \(pressed.joined(separator: ", ")), not \(days).") }
    }
    if let until = arg("--until") {
      let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd HH:mm"
      guard let date = f.date(from: "\(until) 12:00"), let endPop = popups().last, pick(endPop, "on this day"),
            let field = kids(sheet).filter({ role($0) == "AXDateTimeArea" }).last else { emit("repeat_not_set", "Could not set the repeat to end on \(until).") }
      AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, date as CFDate)
      let day = DateFormatter(); day.locale = Locale(identifier: "en_US_POSIX"); day.dateFormat = "yyyy-MM-dd"
      guard waitFor(2, { (attr(field, kAXValueAttribute) as? Date).map { day.string(from: $0) == until } == true ? true : nil }) != nil else { emit("repeat_not_set", "The end date did not take \(until).") }
      facts["repeat_until"] = until
    } else if let times = arg("--times") {
      guard let endPop = popups().last, pick(endPop, "after"), let box = waitFor(2, { kids(sheet).first { role($0) == "AXTextField" } }) else { emit("repeat_not_set", "Could not set the repeat to end after \(times).") }
      AXUIElementSetAttributeValue(box, kAXValueAttribute as CFString, times as CFTypeRef)
      if text(box, kAXValueAttribute) != times { focus(box); key(0, .maskCommand); key(51); type(times) }
      guard waitFor(2, { text(box, kAXValueAttribute) == times ? true : nil }) != nil else { emit("repeat_not_set", "The number of times did not take \(times).") }
      facts["repeat_times"] = Int(times)
    } else if argv.contains("--no-end") {
      guard let endPop = popups().last, pick(endPop, "no end date") else { emit("repeat_not_set", "Could not set the repeat to never end.") }
    }
  }
  facts["repeat_rule"] = ruleText()
  guard let save = all(sheet, { role($0) == "AXButton" && (text($0, kAXTitleAttribute) == "Save" || text($0, kAXDescriptionAttribute) == "Save") }).first, press(save) else { emit("repeat_not_set", "Could not press Save on the Recurrence sheet.") }
  _ = waitFor(3) { kids(win).contains { role($0) == "AXSheet" } ? nil : true }
  let shown = waitFor(3) { () -> String? in let v = text(picker, kAXValueAttribute); return v.isEmpty || v == "Does not repeat" ? nil : v } ?? text(picker, kAXValueAttribute)
  facts["repeat"] = shown
  guard shown != "Does not repeat", !shown.isEmpty else { emit("repeat_not_set", "The invite still does not repeat.") }
  step("repeat")
}

// 3c. A place that is not a bookable room: typed, then Outlook's own suggestion chosen (the first one whose address
// names --near, else the top one), and read back.
if let place = arg("--location") {
  guard let field = first(win, "AXTextField", "Add a location") ?? first(win, "AXTextField", "Locations") else { emit("no_location", "Could not find the location field.") }
  var typed = false
  for _ in 0..<3 {
    outlook.activate(); AXUIElementPerformAction(win, kAXRaiseAction as CFString)
    focus(field); usleep(120_000)
    key(0, .maskCommand); key(51)
    type(place)
    if waitFor(1, { staticOrValue(field).contains(place) ? true : nil }) != nil { typed = true; break }
  }
  guard typed else { emit("typing_blocked", "Outlook did not receive the typing for the location. Nothing was chosen.") }
  var rows: [[String]] = []
  var popup: AXUIElement? = nil
  var noneFound = false
  // Outlook's place lookup sometimes comes back empty ("No Locations Found" for Maplewood, which it found an hour
  // before, 2026-10-09). The wait ends as soon as it says so; the place is then kept as typed, through Outlook's own
  // "Use this location: <place>".
  _ = waitFor(5) { () -> Bool? in
    guard let p = windows().first(where: { text($0, kAXTitleAttribute) == "Locations" }) else { return nil }
    if all(p, { role($0) == "AXStaticText" && text($0, kAXValueAttribute).hasPrefix("No Locations Found") }).first != nil { popup = p; noneFound = true; return true }
    let now = all(p) { role($0) == "AXRow" }.map(staticTexts).filter { !$0.isEmpty }
    if !now.isEmpty && now.count == rows.count { popup = p; return true }
    rows = now; usleep(100_000); return nil
  }
  facts["places"] = rows.prefix(5).map { $0.joined(separator: " / ") }
  let near = arg("--near") ?? ""
  let nearIndex = near.isEmpty ? (rows.isEmpty ? -1 : 0) : (rows.firstIndex { $0.joined(separator: " ").localizedCaseInsensitiveContains(near) } ?? -1)
  if let list = popup, noneFound || nearIndex < 0 {
    // Keep the words as typed.
    guard let use = all(list, { role($0) == "AXButton" && label($0).contains("Use this location") }).first, press(use) else {
      key(53); emit("no_place", "Outlook found no place for \"\(place)\" and offered no way to keep it as typed.")
    }
    let kept = waitFor(3) { () -> String? in
      let t = all(win) { role($0) == "AXTextField" && label($0).contains("Locations") }.first.map(staticTexts)?.joined(separator: " ") ?? ""
      return t.localizedCaseInsensitiveContains(place) ? t : nil
    } ?? ""
    guard !kept.isEmpty else { emit("wrong_place", "The location does not read \(place). Check it before sending.") }
    facts["location"] = place
    facts["location_kept_as_typed"] = true
    step("location")
  } else {
  guard let list = popup, !rows.isEmpty else { key(53); emit("no_place", "Outlook suggested no place for \"\(place)\".") }
  let pick = nearIndex
  let name = rows[pick][0]
  let highlighted = { () -> String in all(list) { role($0) == "AXRow" && (attr($0, kAXSelectedAttribute) as? Bool) == true }.first.map { staticTexts($0).first ?? "" } ?? "" }
  var presses = 0
  while highlighted() != name && presses <= rows.count + 1 { key(125); presses += 1; usleep(slow ? 250_000 : 60_000) }
  guard highlighted() == name else { key(53); emit("place_not_highlighted", "Could not move Outlook's highlight to \(name). Nothing was chosen.") }
  beat(0.5)
  key(36)
  let chosen = waitFor(3) { () -> String? in
    let t = all(win) { role($0) == "AXTextField" && label($0).contains("Locations") }.first.map(staticTexts)?.joined(separator: " ") ?? ""
    return t.hasPrefix(name) ? t : nil
  } ?? ""
  facts["location"] = chosen.components(separatedBy: ", http").first ?? chosen
  guard chosen.hasPrefix(name) else { emit("wrong_place", "The location does not read \(name). Check it before sending.") }
  step("location")
  }
}

// 4. The room, before the body (a long body scrolls the location field out of the window): Outlook's own suggestions for the building, each with its availability for this slot.
if let query = arg("--room-query") {
  let floors = Set(arg("--floors") ?? "")
  guard let field = first(win, "AXTextField", "Add a location") ?? first(win, "AXTextField", "Locations") else { emit("no_location", "Could not find the location field.") }
  // Typing can land elsewhere when another window takes the keyboard (Outlook's reminder pop-up did, 2026-10-08), so
  // Outlook and this window are brought forward first, and the field is read back after typing; up to three tries.
  // No free room at this time: the other times found free for everyone (2b, "also_free") are tried in order, so
  // "a room in Sage next week" finds a time and a room together.
  var roomTimes = (facts["also_free"] as? [String]) ?? []
  // With no listed alternatives, the next times are found only now, and only if this one has no room: a time free for
  // everyone, tried in order, at most four (each try is under a second).
  func nextFreeTime() -> String? {
    if !roomTimes.isEmpty { return roomTimes.removeFirst() }
    var probed = 0
    while probed < 4, let candidate = laterTries.first {
      laterTries.removeFirst(); probed += 1
      let parts = candidate.split(separator: " ").map(String.init)
      if parts.count == 2, shift(to: parts[0]), setStart(parts[1]), everyone(verdict()) { return candidate }
    }
    return nil
  }
  var movedTo: String? = nil
  var tried: [String] = []
  var list: AXUIElement
  var rooms: [(name: String, status: String)] = []
  var pick = 0
  while true {
    var typed = false
    for _ in 0..<3 {
      outlook.activate(); AXUIElementPerformAction(win, kAXRaiseAction as CFString); AXUIElementSetAttributeValue(win, kAXMainAttribute as CFString, kCFBooleanTrue)
      focus(field); usleep(120_000); beat(0.4)
      key(0, .maskCommand); key(51)   // clear what a failed try left
      type(query)
      if waitFor(1, { staticOrValue(field).contains(query) ? true : nil }) != nil { typed = true; break }
    }
    guard typed else { emit("typing_blocked", "Outlook did not receive the typing for the room. Nothing was chosen.") }
    // The list fills in over a second or two; read it once it stops growing. "No Locations Found" ends the wait.
    rooms = []
    var popup: AXUIElement? = nil
    var noneListed = false
    _ = waitFor(10) { () -> Bool? in
      guard let p = windows().first(where: { text($0, kAXTitleAttribute) == "Locations" }) else { return nil }
      if all(p, { role($0) == "AXStaticText" && text($0, kAXValueAttribute).hasPrefix("No Locations Found") }).first != nil { noneListed = true; return true }
      // One row per room: name, then "Available" or "Busy". Rows on 2026-10-09; cells on 2026-10-08. Either is read.
      let byRow = all(p) { role($0) == "AXRow" }.map(staticTexts).filter { $0.count >= 2 }
      let now = (byRow.isEmpty ? all(p) { role($0) == "AXCell" }.map(staticTexts).filter { $0.count >= 2 } : byRow).map { (name: $0[0], status: $0[1]) }
      if now.count >= 3 && now.count == rooms.count { popup = p; return true }
      rooms = now; usleep(150_000); return nil
    }
    guard let found = popup, !noneListed else { key(53); emit("no_rooms", "Outlook listed no rooms for \"\(query)\".") }
    list = found
    facts["rooms"] = rooms.map { "\($0.name): \($0.status)" }
    let floorOf = { (name: String) -> Character? in
      guard let number = name.split(separator: " ").last, number.count == 3, number.allSatisfy(\.isNumber) else { return nil }
      return number.first
    }
    if let free = rooms.firstIndex(where: { $0.name.hasPrefix(query) && $0.status == "Available" && (floors.isEmpty || floorOf($0.name).map(floors.contains) == true) }) { pick = free; break }
    key(53)
    tried.append("\(shownDay() ?? "?") \(String(slotNow().prefix(5)))")
    let floorWords = floors.isEmpty ? "" : " on floor \(floors.sorted().map(String.init).joined(separator: " or "))"
    guard tried.count < 4, let next = nextFreeTime() else { emit("no_free_room", "No \(query) room\(floorWords) is free at \(tried.joined(separator: " or ")).") }
    let parts = next.split(separator: " ").map(String.init)
    guard parts.count == 2, shift(to: parts[0]), setStart(parts[1]) else { emit("time_not_set", "Could not move the invite to \(next) to look for a room.") }
    movedTo = next
  }
  if let moved = movedTo { facts["time_found"] = moved; facts["time_asked_free"] = false; facts["also_free"] = roomTimes; facts["slot"] = slotNow(); facts["room_times_tried"] = tried }
  facts["room_picked"] = rooms[pick].name
  beat(1.0)
  // Arrow down until Outlook's own highlight is on the room (the list sometimes starts on "Use this location", sometimes
  // on the first room), reading the highlighted row after every press rather than counting presses.
  let highlighted = { () -> String in
    let rows = all(list) { role($0) == "AXRow" && (attr($0, kAXSelectedAttribute) as? Bool) == true }
    return rows.first.map { staticTexts($0).first ?? "" } ?? ""
  }
  var steps = 0
  while highlighted() != rooms[pick].name && steps <= rooms.count + 1 { key(125); steps += 1; usleep(slow ? 250_000 : 60_000) }
  facts["arrow_presses"] = steps
  guard highlighted() == rooms[pick].name else { key(53); emit("room_not_highlighted", "Could not move Outlook's highlight to \(rooms[pick].name). Nothing was chosen.") }
  beat(0.5)
  key(36)   // Return chooses
  beat(1.2)
  let roomText = { all(win) { role($0) == "AXTextField" && label($0).contains("Locations") }.first.map(staticTexts)?.joined(separator: " ") ?? "" }
  let chosen = waitFor(3) { roomText().hasPrefix(rooms[pick].name) ? roomText() : nil } ?? roomText()
  facts["location"] = chosen
  guard chosen.hasPrefix(rooms[pick].name) else { emit("wrong_room", "The location reads \"\(chosen)\", not \(rooms[pick].name). Check it before sending.") }
  let roomStatus = all(win) { label($0).contains("\(rooms[pick].name) is ") }.first.map { text($0, kAXDescriptionAttribute) } ?? ""
  facts["room_status"] = roomStatus
  step("room")
}

// 5. The body, pasted as rich text. The user's clipboard is put back afterwards.
if let bodyFile = arg("--body-file") {
  guard let html = try? String(contentsOfFile: bodyFile, encoding: .utf8) else { emit("no_body", "Could not read \(bodyFile).") }
  guard let area = all(win, { role($0) == "AXTextArea" }).first else { emit("no_body_area", "Could not find the invite's body.") }
  let board = NSPasteboard.general
  let saved = board.pasteboardItems?.map { item in item.types.reduce(into: [NSPasteboard.PasteboardType: Data]()) { $0[$1] = item.data(forType: $1) } } ?? []
  board.clearContents()
  board.setString(html, forType: .html)
  board.setString(html.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression), forType: .string)
  focus(area); usleep(100_000); beat(0.3)
  key(9, .maskCommand)   // 9 = V
  _ = waitFor(3) { text(area, kAXValueAttribute).count > 20 ? true : nil }
  beat(0.8)
  key(126, .maskCommand)   // back to the top, so the user sees the people, time and room first
  board.clearContents()
  board.writeObjects(saved.map { types in let item = NSPasteboardItem(); for (t, d) in types { item.setData(d, forType: t) }; return item })
  let pasted = text(area, kAXValueAttribute)
  facts["body_chars"] = pasted.count
  guard pasted.count > 20 else { emit("body_not_pasted", "The body did not paste into the invite.") }
  step("body")
}

// 6. Read back what the user will send. Send is theirs.
facts["subject"] = subject
facts["send_button"] = all(win) { role($0) == "AXButton" && text($0, kAXDescriptionAttribute) == "Send" }.isEmpty ? "absent" : "present"
emit("ready", "The invite is filled in Outlook and waiting for you. Nothing was sent.")
