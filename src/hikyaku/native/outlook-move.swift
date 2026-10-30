// hikyaku's Outlook "move a meeting" helper (loggie-ask-box increment 9). Opens one existing event in New Outlook's
// own event window and moves it to a new day and start, keeping its length, then reads the window back and STOPS. It
// never presses Send or Send update: the moved event waits in its window for the user.
// Mapped live 2026-10-11, read-only first: the calendar week view lists each event as an AXButton (label starts with
// its title) inside an AXGroup labelled with its day ("Sun, Oct 11, 2026"); the week moves with the buttons
// cal_grid_header_previous / cal_grid_header_next / cal_grid_header_today; one real click on an event shows a preview
// whose "Edit Event" opens the event window, the same window a new invite uses (Start time and End time pop-ups,
// MiniSchedulingAssistant Previous/Next day buttons, the slot line "HH:MM - HH:MM, N min, ..."). AXPress on the event
// only selects it, so the click is a real one.
//
//   hikyaku-outlook-move move --title T --day "Sun, Oct 11, 2026" --to-day YYYY-MM-DD --to-start HH:MM [--dry-run]
//     --dry-run opens the event, reads it, and closes the window without changing anything.
//   hikyaku-outlook-move discard --title T   (Undo: close that event window and press Discard Changes)
// Prints one JSON object: {"status": ..., "detail": ..., what it saw, "steps": {step: ms}}.
import AppKit
import ApplicationServices

let OUTLOOK = "com.microsoft.Outlook"
var facts: [String: Any] = [:]
var stepTimes: [String: Int] = [:]
var mark = Date()
func step(_ name: String) { stepTimes[name] = Int(Date().timeIntervalSince(mark) * 1000); mark = Date() }
func emit(_ status: String, _ detail: String) -> Never {
  var out = facts
  out["status"] = status; out["detail"] = detail
  if !stepTimes.isEmpty { out["steps"] = stepTimes }
  let data = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
  exit(0)
}
let argv = CommandLine.arguments
func arg(_ name: String) -> String? { argv.firstIndex(of: name).flatMap { $0 + 1 < argv.count ? argv[$0 + 1] : nil } }

func attr(_ e: AXUIElement, _ a: String) -> AnyObject? { var v: AnyObject?; AXUIElementCopyAttributeValue(e, a as CFString, &v); return v }
func text(_ e: AXUIElement, _ a: String) -> String { (attr(e, a) as? String) ?? "" }
func role(_ e: AXUIElement) -> String { text(e, kAXRoleAttribute) }
func kids(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func all(_ e: AXUIElement, _ f: (AXUIElement) -> Bool, _ depth: Int = 0) -> [AXUIElement] {
  if depth > 40 { return [] }
  var out = f(e) ? [e] : []
  for c in kids(e) { out += all(c, f, depth + 1) }
  return out
}
func press(_ e: AXUIElement) -> Bool { AXUIElementPerformAction(e, kAXPressAction as CFString) == .success }
func waitFor<T>(_ seconds: Double, _ f: () -> T?) -> T? {
  let end = Date().addingTimeInterval(seconds)
  repeat { if let v = f() { return v }; usleep(100_000) } while Date() < end
  return nil
}
let keys = CGEventSource(stateID: .combinedSessionState)
func escape() { for down in [true, false] { CGEvent(keyboardEventSource: keys, virtualKey: 53, keyDown: down)?.post(tap: .cghidEventTap) } }

// discard --title T: the ask box's Undo. Closes the event window whose subject is T and, when Outlook asks, presses
// exactly "Discard Changes" (the dialog also offers Send Update, which is never pressed).
if argv.count > 1, argv[1] == "discard", let subject = arg("--title") {
  guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: OUTLOOK).first else { emit("no-outlook", "Outlook is not running.") }
  let ax = AXUIElementCreateApplication(app.processIdentifier)
  let open = ((attr(ax, kAXWindowsAttribute) as? [AXUIElement]) ?? []).filter { w in
    text(w, "AXIdentifier") != "OutlookWindow" && all(w, { role($0) == "AXTextField" && text($0, kAXDescriptionAttribute) == "Subject" && text($0, kAXValueAttribute).hasPrefix(subject) }).count == 1
  }
  guard open.count == 1, let w = open.first, let close = attr(w, kAXCloseButtonAttribute) else { emit("not-open", "The meeting's window is not open (\(open.count) found), so there is nothing to undo there.") }
  _ = press(close as! AXUIElement)
  if let discard = waitFor(3, { ((attr(ax, kAXWindowsAttribute) as? [AXUIElement]) ?? []).flatMap { all($0, { role($0) == "AXButton" && text($0, kAXTitleAttribute) == "Discard Changes" }) }.first }) { _ = press(discard) }
  let gone = waitFor(3) { ((attr(ax, kAXWindowsAttribute) as? [AXUIElement]) ?? []).contains(where: { $0 == w }) ? nil : true } != nil
  emit(gone ? "discarded" : "still-open", gone ? "The move was undone; the meeting is as it was." : "The window did not close; nothing was sent.")
}
guard argv.count > 1, argv[1] == "move", let title = arg("--title"), let day = arg("--day"), let toDay = arg("--to-day"), let toStart = arg("--to-start") else {
  emit("usage", "hikyaku-outlook-move move --title T --day \"Sun, Oct 11, 2026\" --to-day YYYY-MM-DD --to-start HH:MM [--dry-run]")
}
let dryRun = argv.contains("--dry-run")
guard AXIsProcessTrusted() else { emit("not-trusted", "macOS has not let Loggie use Accessibility.") }
guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: OUTLOOK).first else { emit("no-outlook", "Outlook is not running.") }
let ax = AXUIElementCreateApplication(app.processIdentifier)
func windows() -> [AXUIElement] { (attr(ax, kAXWindowsAttribute) as? [AXUIElement]) ?? [] }
guard let main = windows().first(where: { text($0, "AXIdentifier") == "OutlookWindow" }) else { emit("no-window", "Outlook has no main window open.") }
app.activate()
usleep(300_000)

// 1. The calendar, in week view: View > Go To > Calendar is a menu press, no keys.
func inCalendar() -> Bool { !all(main, { text($0, "AXIdentifier") == "cal_grid_header_next" }).isEmpty }
if !inCalendar() {
  let bar = attr(ax, kAXMenuBarAttribute) as! AXUIElement
  let view = kids(bar).first { text($0, kAXTitleAttribute) == "View" }
  let goTo = view.flatMap { kids($0).first }.flatMap { menu in kids(menu).first { text($0, kAXTitleAttribute) == "Go To" } }
  let calendar = goTo.flatMap { kids($0).first }.flatMap { menu in kids(menu).first { text($0, kAXTitleAttribute) == "Calendar" } }
  guard let calendar, press(calendar), waitFor(4, { inCalendar() ? true : nil }) != nil else { emit("no-calendar", "Outlook did not switch to the calendar.") }
}
step("calendar")

// 2. The event's day in view: from Today, Next week or Previous week until the day group is there (at most 8 weeks).
let dayFormat = DateFormatter(); dayFormat.locale = Locale(identifier: "en_US_POSIX"); dayFormat.dateFormat = "EEE, MMM d, yyyy"
func dayGroup() -> AXUIElement? { all(main, { role($0) == "AXGroup" && text($0, kAXDescriptionAttribute) == day }).first }
if dayGroup() == nil {
  if let today = all(main, { text($0, "AXIdentifier") == "cal_grid_header_today" }).first { _ = press(today); usleep(400_000) }
  let target = dayFormat.date(from: day) ?? Date()
  let forward = target > Date()
  for _ in 0..<8 where dayGroup() == nil {
    guard let b = all(main, { text($0, "AXIdentifier") == (forward ? "cal_grid_header_next" : "cal_grid_header_previous") }).first, press(b) else { break }
    _ = waitFor(2) { dayGroup() }
  }
}
guard let group = dayGroup() else { emit("day-not-shown", "Outlook's calendar did not show \(day).") }
step("week")

// 3. The event on that day: exactly one whose label starts with the title.
let matches = kids(group).filter { role($0) == "AXButton" && text($0, kAXDescriptionAttribute).hasPrefix(title) }
facts["matches"] = matches.count
guard matches.count == 1, let event = matches.first else {
  emit(matches.isEmpty ? "event-not-found" : "ambiguous", matches.isEmpty ? "No event called \"\(title)\" on \(day)." : "\(matches.count) events called \"\(title)\" on \(day); nothing was opened.")
}

// 4. Open it: one real click shows the preview, whose Edit Event opens the event window.
func eventWindow() -> AXUIElement? { windows().first { text($0, "AXIdentifier") != "OutlookWindow" && text($0, kAXTitleAttribute).contains("• Calendar •") } }
var pos = CGPoint.zero, size = CGSize.zero
if let p = attr(event, kAXPositionAttribute) { AXValueGetValue(p as! AXValue, .cgPoint, &pos) }
if let z = attr(event, kAXSizeAttribute) { AXValueGetValue(z as! AXValue, .cgSize, &size) }
let point = CGPoint(x: pos.x + min(size.width / 2, 40), y: pos.y + min(size.height / 2, 10))
for t in [CGEventType.leftMouseDown, .leftMouseUp] { CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap); usleep(40_000) }
if let edit = waitFor(3, { all(main, { role($0) == "AXButton" && text($0, kAXTitleAttribute) == "Edit Event" }).first }) { _ = press(edit) }
guard let win = waitFor(4, { eventWindow() }) else { emit("not-opened", "The event did not open in its own window.") }
step("open")

// 5. The right event, and one the user may change (an invite from someone else has no Start time menu).
let subject = all(win, { role($0) == "AXTextField" && text($0, kAXDescriptionAttribute) == "Subject" }).first.map { text($0, kAXValueAttribute) } ?? ""
guard subject.hasPrefix(title) || title.hasPrefix(subject) && !subject.isEmpty else {
  if let close = attr(win, kAXCloseButtonAttribute) { _ = press(close as! AXUIElement) }
  emit("wrong-event", "The window that opened is not \"\(title)\"; it was closed unchanged.")
}
func popup(_ name: String) -> AXUIElement? { all(win, { role($0) == "AXPopUpButton" && text($0, kAXDescriptionAttribute) == name }).first }
guard popup("Start time") != nil else {
  if let close = attr(win, kAXCloseButtonAttribute) { _ = press(close as! AXUIElement) }
  emit("not-organizer", "This meeting is someone else's, so Outlook does not let you change its time. Ask them, or propose a new time in Outlook.")
}
let slotNow = { all(win) { text($0, "AXIdentifier") == "Placeholder tile" }.first.map { text($0, kAXValueAttribute) } ?? "" }
facts["before"] = String(slotNow().prefix(40))
facts["send_button"] = all(win, { role($0) == "AXButton" && (text($0, kAXTitleAttribute) + text($0, kAXDescriptionAttribute)).hasPrefix("Send") }).first.map { [text($0, kAXTitleAttribute), text($0, kAXDescriptionAttribute)].first { !$0.isEmpty } ?? "Send" } ?? "Send"
if dryRun {
  if let close = attr(win, kAXCloseButtonAttribute) { _ = press(close as! AXUIElement) }
  emit("dry-run", "Found and opened \"\(title)\" (\(facts["before"] ?? "")); closed it unchanged.")
}

// 6. The day, with the mini schedule's day buttons (they move the event itself).
let longDay = DateFormatter(); longDay.locale = Locale(identifier: "en_US"); longDay.dateFormat = "EEEE, MMMM d, yyyy"
let isoDay = DateFormatter(); isoDay.locale = Locale(identifier: "en_US_POSIX"); isoDay.dateFormat = "yyyy-MM-dd"
func shownDay() -> String? {
  for e in all(win, { role($0) == "AXUnknown" && text($0, kAXDescriptionAttribute).range(of: #"^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}, \d{4}$"#, options: .regularExpression) != nil }) {
    if let d = longDay.date(from: text(e, kAXDescriptionAttribute)) { return isoDay.string(from: d) }
  }
  return nil
}
func minutes(_ hhmm: Substring) -> Int? { let p = hhmm.split(separator: ":"); return p.count == 2 ? Int(p[0]).flatMap { h in Int(p[1]).map { h * 60 + $0 } } : nil }
let length: Int? = {
  let parts = slotNow().split(separator: " ")
  guard parts.count >= 3, let a = minutes(parts[0]), let b = minutes(parts[2].prefix(5)) else { return nil }
  return b - a
}()
if let now = shownDay(), let a = isoDay.date(from: now), let b = isoDay.date(from: toDay) {
  let days = Calendar.current.dateComponents([.day], from: a, to: b).day ?? 0
  let id = days > 0 ? "MiniSchedulingAssistantNextDateButton" : "MiniSchedulingAssistantPreviousDateButton"
  for _ in 0..<abs(days) {
    let before = shownDay()
    guard let button = all(win, { text($0, "AXIdentifier") == id }).first, press(button), waitFor(3, { shownDay() != before ? true : nil }) != nil else {
      emit("day-not-set", "The event did not move to \(toDay); it is open in Outlook as it was left (\(slotNow().prefix(30))). Nothing was sent.")
    }
  }
}
guard shownDay() == toDay else { emit("day-not-set", "Outlook shows \(shownDay() ?? "no day") instead of \(toDay). Nothing was sent.") }
step("day")

// 7. The start, from Outlook's own menu; Outlook keeps the length. If it did not, the end is set from its menu too.
func pick(_ menuName: String, _ prefix: String) -> Bool {
  guard let pop = popup(menuName), press(pop) else { return false }
  guard let menu = waitFor(3, { windows().first { text($0, kAXTitleAttribute) == "menuWindow" } }) else { return false }
  guard let cell = waitFor(2, { all(menu, { role($0) == "AXCell" && text($0, kAXDescriptionAttribute).hasPrefix(prefix) }).first }) else { escape(); return false }
  if let row = attr(cell, kAXParentAttribute) { AXUIElementSetAttributeValue(row as! AXUIElement, kAXSelectedAttribute as CFString, kCFBooleanTrue) }
  return press(cell)
}
if !slotNow().hasPrefix("\(toStart) - ") {
  guard pick("Start time", toStart), waitFor(3, { slotNow().hasPrefix("\(toStart) - ") ? true : nil }) != nil else {
    emit("start-not-set", "Outlook did not take \(toStart) as the start (the start menu offers every half hour). The event is open as it was left. Nothing was sent.")
  }
}
if let length, let start = minutes(Substring(toStart)) {
  let want = String(format: "%02d:%02d", ((start + length) / 60) % 24, (start + length) % 60)
  let parts = slotNow().split(separator: " ")
  if parts.count >= 3, !parts[2].hasPrefix(want) { _ = pick("End time", want); _ = waitFor(2) { slotNow().split(separator: " ").dropFirst(2).first?.hasPrefix(want) == true ? true : nil } }
}
step("time")
facts["after"] = String(slotNow().prefix(60))
emit("moved", "The meeting is moved in its Outlook window (\(slotNow().prefix(30))). Press \(facts["send_button"] as? String ?? "Send") there to tell everyone. Nothing was sent.")
