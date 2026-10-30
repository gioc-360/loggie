// hikyaku's calendar helper: lists or removes events through macOS Calendar (EventKit).
// It sees every calendar this Mac syncs, including Outlook's once the Microsoft account is added in
// System Settings > Internet Accounts. Output is JSON on stdout; every refusal is a message on stderr
// and a non-zero exit, never an empty list.
//   calendar list <fromISO> <toISO>
//   calendar calendars           every calendar: id, title, account, type, writable, isDefault
//   calendar remove <eventId>
//   calendar status              {"status":"granted" | "denied" | "unknown"}, read without asking macOS
import EventKit
import Foundation

func fail(_ message: String, _ code: Int32) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(code)
}

let args = CommandLine.arguments

// The setup page polls this, so it only reads the answer macOS already has and never shows the dialog.
if args.count > 1 && args[1] == "status" {
  let status: String
  switch EKEventStore.authorizationStatus(for: .event) {
  case .fullAccess, .authorized: status = "granted"
  case .denied, .restricted, .writeOnly: status = "denied"
  default: status = "unknown"
  }
  print("{\"status\":\"\(status)\"}")
  exit(0)
}

let store = EKEventStore()
let waiting = DispatchSemaphore(value: 0)
var granted = false
store.requestFullAccessToEvents { ok, _ in granted = ok; waiting.signal() }
waiting.wait()
if !granted { fail("hikyaku cannot read your calendars. Allow it in System Settings > Privacy & Security > Calendars.", 3) }

let iso = ISO8601DateFormatter()

func others(_ event: EKEvent) -> [String] {
  (event.attendees ?? []).filter { !$0.isCurrentUser }.map { $0.url.absoluteString.replacingOccurrences(of: "mailto:", with: "") }
}

// The other people's display names, where the invite carries one (a recorded call names its voices from these).
func names(_ event: EKEvent) -> [String] {
  (event.attendees ?? []).filter { !$0.isCurrentUser }.compactMap { person in
    guard let name = person.name?.trimmingCharacters(in: .whitespaces), !name.isEmpty, !name.contains("@") else { return nil }
    return name
  }
}

// Whether an event is his (meeting.js isMine, 2026-10-27): writable cannot tell his calendar from the school's (MBA I
// is writable), so the helper says what kind of calendar it is, whether he organized the event, and his own reply.
func kind(_ calendar: EKCalendar) -> String {
  switch calendar.type {
  case .local: return "local"
  case .calDAV: return "caldav"
  case .exchange: return "exchange"
  case .subscription: return "subscription"
  case .birthday: return "birthday"
  @unknown default: return "other"
  }
}

func reply(_ person: EKParticipant) -> String {
  switch person.participantStatus {
  case .pending: return "pending"
  case .accepted: return "accepted"
  case .declined: return "declined"
  case .tentative: return "tentative"
  case .delegated: return "delegated"
  case .completed: return "completed"
  case .inProcess: return "in-process"
  default: return "unknown"
  }
}

let defaultCalendar = store.defaultCalendarForNewEvents?.calendarIdentifier

func describeCalendar(_ calendar: EKCalendar) -> [String: Any] {
  [
    "id": calendar.calendarIdentifier,
    "title": calendar.title,
    "account": calendar.source.title,
    "type": kind(calendar),
    "writable": calendar.allowsContentModifications,
    "isDefault": calendar.calendarIdentifier == defaultCalendar,
  ]
}

func describe(_ event: EKEvent) -> [String: Any] {
  let me = (event.attendees ?? []).first { $0.isCurrentUser }
  return [
    "id": event.calendarItemIdentifier,
    "title": event.title ?? "",
    "start": iso.string(from: event.startDate),
    "end": iso.string(from: event.endDate),
    "allDay": event.isAllDay,
    "calendar": event.calendar.title,
    "account": event.calendar.source.title,
    "writable": event.calendar.allowsContentModifications,
    "attendees": others(event),
    "attendeeNames": names(event),
    "recurring": event.hasRecurrenceRules,
    "location": event.location ?? "",
    "calendarId": event.calendar.calendarIdentifier,
    "calendarType": kind(event.calendar),
    "isDefault": event.calendar.calendarIdentifier == defaultCalendar,
    "organizerIsMe": event.organizer?.isCurrentUser ?? false,
    "myStatus": me.map(reply) ?? NSNull(),
  ]
}

func printJSON(_ value: Any) {
  let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
}

switch args.count > 1 ? args[1] : "" {
case "list":
  guard args.count > 3, let from = iso.date(from: args[2]), let to = iso.date(from: args[3]), to > from else {
    fail("Usage: calendar list <fromISO> <toISO>", 2)
  }
  let events = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: nil))
    .sorted { $0.startDate < $1.startDate }
  printJSON(events.map(describe))
case "calendars":
  printJSON(store.calendars(for: .event).sorted { ($0.source.title, $0.title) < ($1.source.title, $1.title) }.map(describeCalendar))
case "remove":
  guard args.count > 2, let event = store.calendarItem(withIdentifier: args[2]) as? EKEvent else {
    fail("No event with that id. List your calendar again; ids change when an event is edited.", 4)
  }
  if !others(event).isEmpty { fail("\"\(event.title ?? "")\" has other people on it. Cancel it in Outlook so they are told.", 5) }
  if event.hasRecurrenceRules { fail("\"\(event.title ?? "")\" repeats. hikyaku does not remove repeating events; change it in Outlook.", 6) }
  if !event.calendar.allowsContentModifications { fail("\"\(event.title ?? "")\" is on a calendar you cannot edit (\(event.calendar.title)).", 7) }
  let removed = describe(event)
  do { try store.remove(event, span: .thisEvent, commit: true) } catch { fail("Calendar refused to remove it: \(error.localizedDescription)", 8) }
  printJSON(removed)
default:
  fail("Usage: calendar list <fromISO> <toISO> | calendar calendars | calendar remove <eventId>", 2)
}
