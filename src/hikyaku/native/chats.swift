// hikyaku's chat reader: recent Messages (iMessage/SMS) and WhatsApp Desktop chats on this Mac, read-only, as JSON.
// It opens Messages' chat.db read-only and never opens WhatsApp's live store: the store and its -wal/-shm are
// copied to a private temp folder, read there, and the copy is deleted. Nothing here can write to either app,
// post a key, press anything or send: the only thing it ever sets is a composer's text, back to empty, when asked.
//
//   hikyaku-chats list --days N --max-chats M --max-messages K [--apps messages,whatsapp] [--chat app:id]
//   hikyaku-chats composer --app messages|whatsapp [--wait SECONDS] [--expect-file FILE]
//   hikyaku-chats composer-clear --app messages|whatsapp [--expect-file FILE]   (with the file: only if the box holds exactly it)
//   hikyaku-chats place --app messages|whatsapp --title TITLE (--body-file FILE | --dry-run)
//   hikyaku-chats snapshot --app messages|whatsapp        (read-only copy of the window tree)
//
// list prints {"messages": {status, detail, chats, counts}, "whatsapp": {...}}. A status that is not "ok" says why
// in words (no-access: Full Disk Access is off; not-installed; no-data; error) instead of an empty list.
// composer prints what the front chat window's message box holds, read through Accessibility, so a draft is
// reported as placed only when its text is really there.
import Cocoa
import ApplicationServices
import SQLite3

let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
let iso: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
let home = FileManager.default.homeDirectoryForCurrentUser.path
let MESSAGES_DB = home + "/Library/Messages/chat.db"
let WHATSAPP_APP = "/Applications/WhatsApp.app"
let WHATSAPP_DB = home + "/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite"
let MESSAGES_BUNDLE = "com.apple.MobileSMS"
let WALK_SECONDS = 9.0
let WHATSAPP_BUNDLE = "net.whatsapp.WhatsApp"

func fail(_ message: String, _ code: Int32) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(code)
}
func printJSON(_ value: Any) {
  let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
}
let args = CommandLine.arguments
func arg(_ name: String) -> String? {
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}
func intArg(_ name: String, _ fallback: Int) -> Int { Int(arg(name) ?? "") ?? fallback }

// --- SQLite, read-only, with every error turned into a message
final class Database {
  var db: OpaquePointer?
  init(path: String, flags: Int32) throws {
    if sqlite3_open_v2(path, &db, flags, nil) != SQLITE_OK {
      let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "could not open"
      sqlite3_close(db)
      throw NSError(domain: "sqlite", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
  }
  deinit { sqlite3_close(db) }
  // Rows as arrays of Any (Int64, Double, String, Data or NSNull), bound from the given values.
  func rows(_ sql: String, _ binds: [Any] = []) throws -> [[Any]] {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
      throw NSError(domain: "sqlite", code: 2, userInfo: [NSLocalizedDescriptionKey: String(cString: sqlite3_errmsg(db))])
    }
    defer { sqlite3_finalize(statement) }
    for (i, value) in binds.enumerated() {
      let index = Int32(i + 1)
      switch value {
      case let v as Int64: sqlite3_bind_int64(statement, index, v)
      case let v as Int: sqlite3_bind_int64(statement, index, Int64(v))
      case let v as Double: sqlite3_bind_double(statement, index, v)
      case let v as String: sqlite3_bind_text(statement, index, v, -1, SQLITE_TRANSIENT)
      default: sqlite3_bind_null(statement, index)
      }
    }
    var out: [[Any]] = []
    while true {
      let code = sqlite3_step(statement)
      if code == SQLITE_DONE { break }
      guard code == SQLITE_ROW else {
        throw NSError(domain: "sqlite", code: 3, userInfo: [NSLocalizedDescriptionKey: String(cString: sqlite3_errmsg(db))])
      }
      var row: [Any] = []
      for column in 0..<sqlite3_column_count(statement) {
        switch sqlite3_column_type(statement, column) {
        case SQLITE_INTEGER: row.append(sqlite3_column_int64(statement, column))
        case SQLITE_FLOAT: row.append(sqlite3_column_double(statement, column))
        case SQLITE_TEXT: row.append(String(cString: sqlite3_column_text(statement, column)))
        case SQLITE_BLOB:
          let bytes = sqlite3_column_bytes(statement, column)
          row.append(bytes > 0 ? Data(bytes: sqlite3_column_blob(statement, column), count: Int(bytes)) : Data())
        default: row.append(NSNull())
        }
      }
      out.append(row)
    }
    return out
  }
}
func int(_ v: Any) -> Int64 { (v as? Int64) ?? Int64((v as? Double) ?? 0) }
func double(_ v: Any) -> Double { (v as? Double) ?? Double((v as? Int64) ?? 0) }
func string(_ v: Any) -> String { (v as? String) ?? "" }

// What stops a read, as the status the app shows. EPERM on open is macOS refusing without Full Disk Access.
func openCheck(_ path: String) -> String? {
  let fd = open(path, O_RDONLY)
  if fd >= 0 { close(fd); return nil }
  if errno == ENOENT { return "no-data" }
  if errno == EPERM || errno == EACCES { return "no-access" }
  return "error"
}

// --- Messages: the words of a message are in `text`, or inside attributedBody, an NSAttributedString archived
// in the old "streamtyped" format (about one message in three on this Mac). NSUnarchiver reads it; a plain scan
// of the bytes is the fallback (the string follows "NSString" + 0x01 0x2B + its length).
func streamtypedString(_ data: Data) -> String? {
  let bytes = [UInt8](data)
  guard let marker = "NSString".data(using: .utf8).map([UInt8].init) else { return nil }
  var i = 0
  while i + marker.count + 3 < bytes.count {
    if Array(bytes[i..<i + marker.count]) == marker {
      var p = i + marker.count
      // skip the class-version bytes up to the 0x01 0x2B type marker
      while p + 1 < bytes.count && !(bytes[p] == 0x01 && bytes[p + 1] == 0x2B) { p += 1; if p > i + marker.count + 8 { break } }
      guard p + 2 < bytes.count, bytes[p] == 0x01, bytes[p + 1] == 0x2B else { i += 1; continue }
      p += 2
      var length = Int(bytes[p]); p += 1
      if length == 0x81, p + 1 < bytes.count { length = Int(bytes[p]) | (Int(bytes[p + 1]) << 8); p += 2 }
      else if length == 0x82, p + 3 < bytes.count { length = Int(bytes[p]) | (Int(bytes[p + 1]) << 8) | (Int(bytes[p + 2]) << 16) | (Int(bytes[p + 3]) << 24); p += 4 }
      guard p + length <= bytes.count else { return nil }
      return String(bytes: bytes[p..<p + length], encoding: .utf8)
    }
    i += 1
  }
  return nil
}
func decodeBody(_ data: Data) -> String? {
  guard !data.isEmpty else { return nil }
  if let archived = NSUnarchiver.unarchiveObject(with: data) as? NSAttributedString { return archived.string }
  return streamtypedString(data)
}
// Never the contents of a picture or file, only what kind it is.
func placeholder(mime: String, uti: String) -> String {
  let kind = (mime + " " + uti).lowercased()
  if kind.contains("image") || kind.contains("png") || kind.contains("jpeg") || kind.contains("heic") || kind.contains("gif") { return "[photo]" }
  if kind.contains("video") || kind.contains("movie") || kind.contains("mp4") { return "[video]" }
  if kind.contains("audio") || kind.contains("caf") || kind.contains("amr") { return "[voice message]" }
  if kind.contains("vcard") || kind.contains("contact") { return "[contact]" }
  return "[attachment]"
}
func cleanText(_ s: String) -> String {
  s.replacingOccurrences(of: "\u{fffc}", with: "").replacingOccurrences(of: "\u{fffd}", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
}
func appleDate(_ raw: Int64) -> Date {
  // Nanoseconds since 2001 on current macOS; whole seconds in rows written before 2017.
  let seconds = raw > 10_000_000_000 ? Double(raw) / 1_000_000_000 : Double(raw)
  return Date(timeIntervalSinceReferenceDate: seconds)
}

func readMessages(days: Int, maxChats: Int, maxMessages: Int, onlyChat: String?) -> [String: Any] {
  if let status = openCheck(MESSAGES_DB) {
    let detail = status == "no-access" ? "macOS has not let this app read Messages (Full Disk Access is off)."
      : status == "no-data" ? "Messages has no chat database on this Mac." : "Messages' database could not be opened: \(String(cString: strerror(errno)))."
    return ["status": status, "detail": detail, "chats": [], "counts": ["chats": 0, "messages": 0, "newest": NSNull()]]
  }
  do {
    let db = try Database(path: MESSAGES_DB, flags: SQLITE_OPEN_READONLY)
    let cutoff = Int64((Date().timeIntervalSinceReferenceDate - Double(days) * 86400) * 1_000_000_000)
    // Only real messages: item_type 0 (no "X left the chat"), no tapback reactions (associated_message_type 2000+).
    let filter = "m.item_type = 0 AND m.associated_message_type = 0 AND m.date > ?"
    let chatRows = try db.rows("""
      SELECT c.ROWID, c.guid, IFNULL(c.chat_identifier, ''), IFNULL(c.display_name, ''), c.style, IFNULL(c.service_name, ''), MAX(m.date)
      FROM chat c JOIN chat_message_join j ON j.chat_id = c.ROWID JOIN message m ON m.ROWID = j.message_id
      WHERE \(filter) \(onlyChat != nil ? "AND c.ROWID = ?" : "")
      GROUP BY c.ROWID ORDER BY MAX(m.date) DESC LIMIT ?
      """, onlyChat != nil ? [cutoff, Int64(onlyChat!) ?? -1, maxChats] : [cutoff, maxChats])
    var chats: [[String: Any]] = []
    var total = 0
    var newest: Date? = nil
    for row in chatRows {
      let chatId = int(row[0])
      let isGroup = int(row[4]) == 43
      let handles = try db.rows("SELECT IFNULL(h.id, '') FROM chat_handle_join j JOIN handle h ON h.ROWID = j.handle_id WHERE j.chat_id = ?", [chatId]).map { string($0[0]) }.filter { !$0.isEmpty }
      let identifier = string(row[2])
      let title = string(row[3]).isEmpty ? (isGroup ? handles.joined(separator: ", ") : identifier) : string(row[3])
      let messageRows = try db.rows("""
        SELECT m.ROWID, m.text, m.attributedBody, m.is_from_me, m.date, m.cache_has_attachments, IFNULL(h.id, '')
        FROM message m JOIN chat_message_join j ON j.message_id = m.ROWID LEFT JOIN handle h ON h.ROWID = m.handle_id
        WHERE j.chat_id = ? AND \(filter) ORDER BY m.date DESC LIMIT ?
        """, [chatId, cutoff, maxMessages])
      var messages: [[String: Any]] = []
      for m in messageRows.reversed() {
        var text = cleanText(string(m[1]))
        if text.isEmpty, let data = m[2] as? Data, let decoded = decodeBody(data) { text = cleanText(decoded) }
        if int(m[5]) == 1 {
          let files = try db.rows("SELECT IFNULL(a.mime_type, ''), IFNULL(a.uti, '') FROM message_attachment_join j JOIN attachment a ON a.ROWID = j.attachment_id WHERE j.message_id = ?", [int(m[0])])
          let marks = files.isEmpty ? ["[attachment]"] : files.map { placeholder(mime: string($0[0]), uti: string($0[1])) }
          text = (text.isEmpty ? "" : text + " ") + marks.joined(separator: " ")
        }
        if text.isEmpty { text = "[message]" }
        let fromMe = int(m[3]) == 1
        let when = appleDate(int(m[4]))
        if newest == nil || when > newest! { newest = when }
        messages.append(["id": String(int(m[0])), "fromMe": fromMe, "from": fromMe ? "" : string(m[6]), "timestamp": iso.string(from: when), "text": text])
      }
      total += messages.count
      chats.append([
        "app": "messages", "id": String(chatId), "guid": string(row[1]), "title": title, "isGroup": isGroup, "service": string(row[5]),
        "participants": handles.map { ["handle": $0, "name": NSNull()] },
        "address": isGroup ? NSNull() : (handles.first ?? identifier),
        "messages": messages,
      ])
    }
    // The user's own iMessage addresses and numbers ("E:address", "P:number" on their sent messages), so a group
    // message that names them can be seen as aimed at them. Stays on this Mac; never shown to a model as such.
    let me = try db.rows("SELECT DISTINCT account FROM message WHERE is_from_me = 1 AND account IS NOT NULL AND account != '' AND date > ?", [cutoff])
      .map { string($0[0]) }.map { $0.hasPrefix("E:") || $0.hasPrefix("P:") ? String($0.dropFirst(2)) : $0 }.filter { !$0.isEmpty }
    return ["status": "ok", "detail": "", "self": me, "chats": chats, "counts": ["chats": chats.count, "messages": total, "newest": newest.map { iso.string(from: $0) } ?? NSNull()]]
  } catch {
    let message = error.localizedDescription
    let denied = message.lowercased().contains("authorization denied") || message.lowercased().contains("unable to open")
    return ["status": denied ? "no-access" : "error", "detail": denied ? "macOS has not let this app read Messages (Full Disk Access is off)." : "Messages' database could not be read: \(message)", "chats": [], "counts": ["chats": 0, "messages": 0, "newest": NSNull()]]
  }
}

// --- WhatsApp Desktop. Message types seen on a real store: 0 text, 1 photo, 2 video, 3 voice, 4 contact, 5 location,
// 8 file, 11 gif, 14 deleted, 15 sticker. Group events (6) and the types not understood are left out, never shown as words.
let WHATSAPP_TYPES: [Int64: String] = [0: "", 1: "[photo]", 2: "[video]", 3: "[voice message]", 4: "[contact]", 5: "[location]", 8: "[file]", 11: "[gif]", 14: "[deleted message]", 15: "[sticker]"]
func jidHandle(_ jid: String) -> String {
  guard let at = jid.firstIndex(of: "@") else { return jid }
  let user = String(jid[..<at])
  // A "lid" is WhatsApp's linked identity, not a phone number: kept visibly different, never dialled.
  return jid.hasSuffix("@lid") ? user + "@lid" : user
}
func phoneDigits(_ jid: String) -> String? {
  guard jid.hasSuffix("@s.whatsapp.net"), let at = jid.firstIndex(of: "@") else { return nil }
  let digits = String(jid[..<at])
  return digits.allSatisfy({ $0.isNumber }) && digits.count >= 7 ? digits : nil
}

func readWhatsApp(days: Int, maxChats: Int, maxMessages: Int, onlyChat: String?) -> [String: Any] {
  let empty: [String: Any] = ["chats": [], "counts": ["chats": 0, "messages": 0, "newest": NSNull()]]
  if !FileManager.default.fileExists(atPath: WHATSAPP_APP) {
    return empty.merging(["status": "not-installed", "detail": "WhatsApp Desktop is not in /Applications."]) { $1 }
  }
  if let status = openCheck(WHATSAPP_DB) {
    let detail = status == "no-access" ? "macOS has not let this app read WhatsApp's chats (Full Disk Access is off)."
      : status == "no-data" ? "WhatsApp Desktop has not stored any chats on this Mac yet." : "WhatsApp's store could not be opened: \(String(cString: strerror(errno)))."
    return empty.merging(["status": status, "detail": detail]) { $1 }
  }
  // Never the live store: a private copy of the store and its write-ahead log, deleted when done.
  let folder = FileManager.default.temporaryDirectory.appendingPathComponent("hikyaku-chats-" + UUID().uuidString)
  defer { try? FileManager.default.removeItem(at: folder) }
  do {
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    for suffix in ["", "-wal", "-shm"] where FileManager.default.fileExists(atPath: WHATSAPP_DB + suffix) {
      try FileManager.default.copyItem(atPath: WHATSAPP_DB + suffix, toPath: folder.appendingPathComponent("ChatStorage.sqlite" + suffix).path)
    }
  } catch {
    return empty.merging(["status": "no-access", "detail": "WhatsApp's store could not be copied for reading: \(error.localizedDescription)"]) { $1 }
  }
  do {
    let db = try Database(path: folder.appendingPathComponent("ChatStorage.sqlite").path, flags: SQLITE_OPEN_READWRITE)
    let cutoff = Date().timeIntervalSinceReferenceDate - Double(days) * 86400
    let types = WHATSAPP_TYPES.keys.map(String.init).joined(separator: ",")
    let filter = "m.ZMESSAGEDATE > ? AND m.ZMESSAGETYPE IN (\(types))"
    var pushNames: [String: String] = [:]
    for row in try db.rows("SELECT IFNULL(ZJID, ''), IFNULL(ZPUSHNAME, '') FROM ZWAPROFILEPUSHNAME") where !string(row[1]).isEmpty { pushNames[string(row[0])] = string(row[1]) }
    let sessionRows = try db.rows("""
      SELECT s.Z_PK, IFNULL(s.ZCONTACTJID, ''), IFNULL(s.ZPARTNERNAME, ''), IFNULL(s.ZSESSIONTYPE, 0), MAX(m.ZMESSAGEDATE)
      FROM ZWACHATSESSION s JOIN ZWAMESSAGE m ON m.ZCHATSESSION = s.Z_PK
      WHERE \(filter) AND IFNULL(s.ZSESSIONTYPE, 0) IN (0, 1) AND IFNULL(s.ZREMOVED, 0) = 0 AND s.ZCONTACTJID NOT LIKE '%@broadcast' \(onlyChat != nil ? "AND s.Z_PK = ?" : "")
      GROUP BY s.Z_PK ORDER BY MAX(m.ZMESSAGEDATE) DESC LIMIT ?
      """, onlyChat != nil ? [cutoff, Int64(onlyChat!) ?? -1, maxChats] : [cutoff, maxChats])
    var chats: [[String: Any]] = []
    var total = 0
    var newest: Date? = nil
    for row in sessionRows {
      let sessionId = int(row[0])
      let jid = string(row[1])
      let isGroup = int(row[3]) == 1 || jid.hasSuffix("@g.us")
      let partner = string(row[2])
      var participants: [[String: Any]] = []
      if isGroup {
        for member in try db.rows("SELECT IFNULL(ZMEMBERJID, '') FROM ZWAGROUPMEMBER WHERE ZCHATSESSION = ?", [sessionId]) where !string(member[0]).isEmpty {
          participants.append(["handle": jidHandle(string(member[0])), "name": pushNames[string(member[0])] ?? NSNull()])
        }
      } else {
        participants.append(["handle": jidHandle(jid), "name": partner.isEmpty ? (pushNames[jid] ?? NSNull()) : partner])
      }
      let messageRows = try db.rows("""
        SELECT m.Z_PK, IFNULL(m.ZTEXT, ''), IFNULL(m.ZISFROMME, 0), m.ZMESSAGEDATE, m.ZMESSAGETYPE, IFNULL(m.ZFROMJID, '')
        FROM ZWAMESSAGE m WHERE m.ZCHATSESSION = ? AND \(filter) ORDER BY m.ZMESSAGEDATE DESC LIMIT ?
        """, [sessionId, cutoff, maxMessages])
      var messages: [[String: Any]] = []
      for m in messageRows.reversed() {
        let mark = WHATSAPP_TYPES[int(m[4])] ?? ""
        var text = cleanText(string(m[1]))
        if !mark.isEmpty { text = text.isEmpty ? mark : "\(mark) \(text)" }
        if text.isEmpty { text = "[message]" }
        let fromMe = int(m[2]) == 1
        let fromJid = string(m[5])
        let from = fromMe ? "" : (isGroup ? (pushNames[fromJid] ?? jidHandle(fromJid)) : (partner.isEmpty ? jidHandle(jid) : partner))
        let when = Date(timeIntervalSinceReferenceDate: double(m[3]))
        if newest == nil || when > newest! { newest = when }
        messages.append(["id": String(int(m[0])), "fromMe": fromMe, "from": from, "timestamp": iso.string(from: when), "text": text])
      }
      total += messages.count
      chats.append([
        "app": "whatsapp", "id": String(sessionId), "guid": jid, "title": partner.isEmpty ? jidHandle(jid) : partner, "isGroup": isGroup, "service": "whatsapp",
        "participants": participants,
        "address": isGroup ? NSNull() : (phoneDigits(jid) ?? NSNull()),
        "messages": messages,
      ])
    }
    return ["status": "ok", "detail": "", "chats": chats, "counts": ["chats": chats.count, "messages": total, "newest": newest.map { iso.string(from: $0) } ?? NSNull()]]
  } catch {
    return empty.merging(["status": "error", "detail": "WhatsApp's store could not be read: \(error.localizedDescription)"]) { $1 }
  }
}

// --- the composer, through Accessibility: read what the front chat window's message box holds (and, on request,
// set it back to empty). Elements are found by role and identifier; nothing is pressed, no key is posted.
func attr(_ e: AXUIElement, _ k: String) -> CFTypeRef? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(e, k as CFString, &v) == .success ? v : nil
}
func text(_ e: AXUIElement, _ k: String) -> String { (attr(e, k) as? String) ?? "" }
func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func editable(_ e: AXUIElement) -> Bool {
  var settable: DarwinBoolean = false
  return AXUIElementIsAttributeSettable(e, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
}
func find(_ root: AXUIElement, limit: Int = 8000, _ match: (AXUIElement) -> Bool) -> [AXUIElement] {
  var found: [AXUIElement] = [], stack = [root], seen = 0
  var visited = Set<Int>()
  while let e = stack.popLast(), seen < limit {
    let key = Int(CFHash(e))
    if visited.contains(key) { continue }
    visited.insert(key); seen += 1
    if match(e) { found.append(e) }
    stack.append(contentsOf: children(e).reversed())
  }
  return found
}
// The message box, by the identifier each app gives it (mapped read-only 2026-10-05): Messages' is
// messageBodyField (an AXTextField; the AXTextAreas in its window are the transcript's bubbles), WhatsApp's is
// ChatBar_ComposerTextView.
func composerId(_ whatsapp: Bool) -> String { whatsapp ? "ChatBar_ComposerTextView" : "messageBodyField" }
func composer(_ appElement: AXUIElement, whatsapp: Bool) -> (AXUIElement, String)? {
  let windows = (attr(appElement, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  let front = (attr(appElement, kAXFocusedWindowAttribute).map { $0 as! AXUIElement }).map { [$0] } ?? []
  for window in front + windows {
    let title = text(window, kAXTitleAttribute)
    if let hit = find(window, { text($0, "AXIdentifier") == composerId(whatsapp) && editable($0) }).first { return (hit, title) }
  }
  return nil
}

// --- placing a draft in a chat found by its title (groups, and chats no link can open). Read, verify, set, read
// back: find the one row whose name is the title, open it, check the open chat's header is that title, check the
// message box is empty, set its value, read it back. Any doubt is a status and nothing is inserted. No key is ever
// posted; the only actions performed are opening a chat row and scrolling the chat list.
// A name as it is compared: letters and digits only, one space between words, lowercased. Punctuation, emoji,
// direction marks and spacing are ignored (the user's decision, 2026-10-05: the list and the store spell six of
// eight group names apart by an emoji, an apostrophe or a space); the words themselves must still be identical.
func normalize(_ s: String) -> String {
  let kept = s.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : " " }
  return String(kept).components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ").lowercased()
}
// A row reads "Name, preview, time": the name is what comes before the first comma-space.
func rowName(_ s: String) -> String {
  let n = normalize(s)
  return n.components(separatedBy: ", ").first ?? n
}
func elementById(_ root: AXUIElement, _ id: String) -> AXUIElement? { find(root) { text($0, "AXIdentifier") == id }.first }
// Where the rows live. WhatsApp names its table. Messages names its list only in the narrow layout
// (ConversationList); in the wide layout (mapped 2026-10-05) the rows sit in the unnamed group beside the search
// box, the one with the most children. nil when the app shows no list at all (Messages hides it in a very narrow window).
func chatList(_ root: AXUIElement, whatsapp: Bool) -> AXUIElement? {
  if whatsapp { return elementById(root, "ChatListView_TableView") }
  if let named = elementById(root, "ConversationList") { return named }
  guard let search = elementById(root, "CKConversationListCollectionView"), let p = attr(search, kAXParentAttribute).map({ $0 as! AXUIElement }) else { return nil }
  let siblings = children(p).filter { !CFEqual($0, search) }
  let containers = siblings.flatMap { find($0, limit: 2000) { children($0).count >= 3 } }
  return containers.max { children($0).count < children($1).count }
}
// A row's bare chat name is its input label (mapped 2026-10-05 in both apps); the value or description is
// "name, preview, time, ...", used only when the label is missing.
func rowElements(_ list: AXUIElement, whatsapp: Bool) -> [AXUIElement] {
  if whatsapp { return children(list).compactMap { row in text(row, kAXRoleAttribute) == "AXButton" ? row : children(row).first { text($0, kAXRoleAttribute) == "AXButton" } } }
  return ((attr(list, "AXChildrenInNavigationOrder") as? [AXUIElement]) ?? children(list)).filter { ["AXButton", "AXStaticText", "AXGroup", "AXRow", "AXCell"].contains(text($0, kAXRoleAttribute)) }
}
// Each row with the names it goes by: its input label, and the first part of its value or description. A row
// matches a title only when one of them is exactly the title.
func chatRows(_ root: AXUIElement, whatsapp: Bool) -> [(AXUIElement, [String])] {
  guard let list = chatList(root, whatsapp: whatsapp) else { return [] }
  // One attribute read per row on the fast path (the input label is the bare name); the value and description are
  // read only for a row without one. The walk is bounded by the clock, so every read counts.
  return rowElements(list, whatsapp: whatsapp).compactMap { row in
    if let labels = attr(row, "AXUserInputLabels") as? [String], let first = labels.first, !normalize(first).isEmpty {
      return text(row, "AXIdentifier") == "ChatListView_archiveCell" ? nil : (row, [normalize(first)])
    }
    if text(row, "AXIdentifier") == "ChatListView_archiveCell" || text(row, kAXSubroleAttribute) == "AXSearchField" { return nil }
    let names = [text(row, kAXValueAttribute), text(row, kAXDescriptionAttribute)].filter { !$0.isEmpty }.map(rowName)
    return names.isEmpty ? nil : (row, Array(Set(names)))
  }
}
// Pages up until the rows stop changing (bounded), so a search starts at the newest chats.
func scrollToTop(_ list: AXUIElement, whatsapp: Bool) {
  var last: [String] = []
  for _ in 0..<80 {
    let now = rowElements(list, whatsapp: whatsapp).prefix(3).map { text($0, kAXDescriptionAttribute) + text($0, kAXValueAttribute) }
    if now == last && !now.isEmpty { return }
    last = now
    guard AXUIElementPerformAction(list, "AXScrollUpByPage" as CFString) == .success else { return }
    usleep(150_000)
  }
}
func headerTitle(_ root: AXUIElement, whatsapp: Bool) -> String {
  if whatsapp { return elementById(root, "NavigationBar_HeaderViewButton").map { normalize(text($0, kAXDescriptionAttribute)) } ?? "" }
  return elementById(root, "ConversationTitle").map { normalize(text($0, kAXValueAttribute)) } ?? ""
}
// Nothing named send is ever acted on, whatever else this helper is asked to open.
func safeToAct(_ e: AXUIElement) -> Bool {
  let words = [text(e, "AXIdentifier"), text(e, kAXTitleAttribute), text(e, kAXDescriptionAttribute), text(e, kAXValueAttribute)].joined(separator: " ").lowercased()
  return !words.contains("send")
}
func waitFor<T>(_ seconds: Double, _ probe: () -> T?) -> T? {
  let end = Date().addingTimeInterval(seconds)
  repeat { if let v = probe() { return v }; usleep(250_000) } while Date() < end
  return nil
}
func placeCommand() {
  guard let app = arg("--app"), app == "messages" || app == "whatsapp", let wanted = arg("--title"), !wanted.isEmpty else {
    fail("Usage: place --app messages|whatsapp --title TITLE [--body-file FILE | --dry-run]", 2)
  }
  let whatsapp = app == "whatsapp", appName = whatsapp ? "WhatsApp" : "Messages"
  let dryRun = args.contains("--dry-run")
  let body = arg("--body-file").flatMap { try? String(contentsOfFile: $0, encoding: .utf8) }?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  if !dryRun && body.isEmpty { printJSON(["status": "no-draft", "detail": "The draft is empty."]); return }
  if !AXIsProcessTrusted() { printJSON(["status": "not-trusted", "detail": "macOS has not allowed this app to read other apps' windows (Accessibility)."]); return }
  guard let running = NSRunningApplication.runningApplications(withBundleIdentifier: whatsapp ? WHATSAPP_BUNDLE : MESSAGES_BUNDLE).first else {
    printJSON(["status": "not-running", "detail": "\(appName) is not running."]); return
  }
  let root = AXUIElementCreateApplication(running.processIdentifier)
  let title = normalize(wanted)
  var how = "visible"
  func matches() -> [AXUIElement] { chatRows(root, whatsapp: whatsapp).filter { $0.1.contains(title) }.map { $0.0 } }
  // Both apps fill their chat list only once they have been brought forward (Messages' sidebar is empty in the
  // accessibility tree until then, measured 2026-10-05). The app that was in front gets the front back unless the
  // draft was placed, in which case the user is about to press Send there.
  let wasFront = NSWorkspace.shared.frontmostApplication
  running.activate()
  let giveBack = { if let app = wasFront, app.processIdentifier != running.processIdentifier { app.activate() } }
  _ = waitFor(4) { chatList(root, whatsapp: whatsapp).flatMap { rowElements($0, whatsapp: whatsapp).isEmpty ? nil : true } }
  // No list, no search: Messages hides its chat list in a narrow window, and nothing here guesses.
  guard let list = chatList(root, whatsapp: whatsapp) else {
    giveBack(); printJSON(["status": "no-chat-list", "detail": "\(appName) shows no chat list in its window, so no chat could be found. Open its chat list and try again."]); return
  }
  // The list is paged, newest first, from the top, a bounded number of times; the search fields are never used
  // (setting Messages' one changed its layout, 2026-10-05). On a miss the list goes back to the top.
  scrollToTop(list, whatsapp: whatsapp)
  var found = matches()
  // Not visible: the last visible row is scrolled into view, one step at a time (a page scroll skips rows, measured
  // 2026-10-05: 7 of 28 group names found by page, all by step), until no new row appears. Bounded.
  // The walk stops after WALK_SECONDS (the user's cap, 2026-10-05: nine seconds covers the recent screens, where a
  // waiting group almost always sits); a miss then falls back fast with the reason instead of a minute of scrolling.
  var seen = Set<String>()
  var steps = 0
  let walkEnd = Date().addingTimeInterval(WALK_SECONDS)
  while found.isEmpty && steps < 400 && Date() < walkEnd {
    let rows = chatRows(root, whatsapp: whatsapp)
    let names = Set(rows.flatMap { $0.1 })
    if names.isSubset(of: seen) { break }
    seen.formUnion(names)
    guard let last = rows.last?.0, AXUIElementPerformAction(last, "AXScrollToVisible" as CFString) == .success else { break }
    steps += 1
    found = matches()
    how = "scrolled \(steps)"
  }
  let back = { scrollToTop(list, whatsapp: whatsapp); giveBack() }
  if found.isEmpty {
    back()
    let timedOut = Date() >= walkEnd
    printJSON(["status": "chat-not-found", "detail": timedOut ? "No chat named like this one is in the first \(Int(WALK_SECONDS)) seconds of \(appName)'s list, so hikyaku stopped looking." : "No chat named like this one is in \(appName)'s list.", "how": how, "timedOut": timedOut]); return
  }
  if found.count > 1 { back(); printJSON(["status": "ambiguous-title", "detail": "\(found.count) chats in \(appName) carry this exact name, so hikyaku did not pick one.", "how": how, "matches": found.count]); return }
  let row = found[0]
  guard safeToAct(row) else { back(); printJSON(["status": "refused", "detail": "The row to open is named like a send control; nothing was pressed."]); return }
  let headerBefore = headerTitle(root, whatsapp: whatsapp)
  AXUIElementPerformAction(row, kAXPressAction as CFString)
  var header = waitFor(5) { let h = headerTitle(root, whatsapp: whatsapp); return h == title ? h : nil }
  if header == nil, !whatsapp {
    AXUIElementSetAttributeValue(list, "AXSelectedChildren" as CFString, [row] as CFTypeRef)
    header = waitFor(3) { let h = headerTitle(root, whatsapp: whatsapp); return h == title ? h : nil }
  }
  guard header != nil else {
    giveBack()
    // Messages' list rows take no selection through Accessibility on macOS 27 (measured 2026-10-05: AXPress, AXSelected,
    // AXSelectedChildren and focus all leave the open chat as it was), so the chat simply does not open there.
    if headerTitle(root, whatsapp: whatsapp) == headerBefore {
      printJSON(["status": "chat-did-not-open", "detail": "\(appName) did not switch to that chat when its row was opened, so nothing was inserted.", "how": how, "headerMatches": false]); return
    }
    printJSON(["status": "wrong-chat", "detail": "The chat that opened in \(appName) is not named like this one, so nothing was inserted.", "how": how, "headerMatches": false]); return
  }
  guard let (box, window) = composer(root, whatsapp: whatsapp) else { giveBack(); printJSON(["status": "no-composer", "detail": "The chat is open but no message box was found.", "how": how, "headerMatches": true]); return }
  let before = text(box, kAXValueAttribute).trimmingCharacters(in: .whitespacesAndNewlines)
  if !before.isEmpty { giveBack(); printJSON(["status": "composer-not-empty", "detail": "The chat's message box already holds text, so nothing was inserted over it.", "how": how, "headerMatches": true]); return }
  if dryRun { giveBack(); printJSON(["status": "dry-run", "detail": "The chat was found and its name verified; nothing was inserted.", "how": how, "headerMatches": true, "window": window]); return }
  AXUIElementSetAttributeValue(box, kAXValueAttribute as CFString, body as CFTypeRef)
  let firstLine = body.split(separator: "\n").map { String($0).trimmingCharacters(in: .whitespaces) }.first(where: { !$0.isEmpty }) ?? body
  let placed = waitFor(3) { text(box, kAXValueAttribute).contains(firstLine) ? true : nil } ?? false
  if !placed { giveBack() }
  printJSON(["status": placed ? "placed" : "not-placed", "detail": placed ? "The draft is in the chat's message box. Nothing was sent." : "The message box did not take the draft.", "how": how, "headerMatches": true, "window": window, "text": String(text(box, kAXValueAttribute).prefix(4000))])
}

func composerCommand(clear: Bool) {
  guard let app = arg("--app"), app == "messages" || app == "whatsapp" else { fail("Usage: composer --app messages|whatsapp [--wait SECONDS] [--expect-file FILE]", 2) }
  let whatsapp = app == "whatsapp"
  if !AXIsProcessTrusted() { printJSON(["status": "not-trusted", "detail": "macOS has not allowed this app to read other apps' windows (Accessibility)."]); return }
  let bundle = whatsapp ? WHATSAPP_BUNDLE : MESSAGES_BUNDLE
  let wait = Double(arg("--wait") ?? "") ?? 8
  let expected = arg("--expect-file").flatMap { try? String(contentsOfFile: $0, encoding: .utf8) }?.trimmingCharacters(in: .whitespacesAndNewlines)
  let firstLine: String = expected?.split(separator: "\n").map { String($0).trimmingCharacters(in: .whitespaces) }.first(where: { !$0.isEmpty }) ?? ""
  let end = Date().addingTimeInterval(wait)
  var last: [String: Any] = ["status": "not-running", "detail": "\(whatsapp ? "WhatsApp" : "Messages") is not running."]
  repeat {
    if let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first {
      let element = AXUIElementCreateApplication(running.processIdentifier)
      if let (box, title) = composer(element, whatsapp: whatsapp) {
        if clear {
          // With --expect-file (the ask box's Undo), the box is cleared only when it holds exactly the text Loggie
          // put there: a box the user has since typed in, or another chat's box, is left alone.
          if let expected, text(box, kAXValueAttribute).trimmingCharacters(in: .whitespacesAndNewlines) != expected {
            printJSON(["status": "not-ours", "window": title, "detail": "The message box holds other text now, so it was left as it is."])
            return
          }
          // Set to empty, then wait for the app to show it empty (Messages takes a moment, measured 2026-10-05).
          AXUIElementSetAttributeValue(box, kAXValueAttribute as CFString, "" as CFTypeRef)
          let empty = waitFor(3) { text(box, kAXValueAttribute).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? true : nil } ?? false
          let after = text(box, kAXValueAttribute)
          printJSON(["status": empty ? "cleared" : "not-cleared", "window": title, "text": String(after.prefix(4000))])
          return
        }
        let value = text(box, kAXValueAttribute)
        let matched = !firstLine.isEmpty && value.contains(firstLine)
        last = ["status": "found", "window": title, "text": String(value.prefix(4000)), "matched": matched]
        if matched || firstLine.isEmpty { printJSON(last); return }
      } else {
        last = ["status": "no-composer", "detail": "No message box was found in \(whatsapp ? "WhatsApp" : "Messages")' front window."]
      }
    }
    usleep(400_000)
  } while Date() < end
  printJSON(last)
}


// Read-only copy of an app's front window tree, for mapping where the chat list, the header and the composer are.
func snapshotCommand() {
  guard let app = arg("--app"), app == "messages" || app == "whatsapp" else { fail("Usage: snapshot --app messages|whatsapp [--depth N]", 2) }
  if !AXIsProcessTrusted() { printJSON(["status": "not-trusted"]); return }
  let bundle = app == "whatsapp" ? WHATSAPP_BUNDLE : MESSAGES_BUNDLE
  guard let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first else { printJSON(["status": "not-running"]); return }
  let element = AXUIElementCreateApplication(running.processIdentifier)
  let maxDepth = intArg("--depth", 30)
  var budget = 6000
  func copy(_ e: AXUIElement, _ depth: Int) -> [String: Any] {
    var n: [String: Any] = ["role": text(e, kAXRoleAttribute)]
    for (key, k) in [("id", "AXIdentifier"), ("title", kAXTitleAttribute), ("desc", kAXDescriptionAttribute), ("subrole", kAXSubroleAttribute)] { let v = text(e, k); if !v.isEmpty { n[key] = v } }
    if let v = attr(e, kAXValueAttribute) as? String, !v.isEmpty { n["value"] = String(v.prefix(80)) }
    if let s = attr(e, kAXSelectedAttribute) as? Bool, s { n["selected"] = true }
    if editable(e) { n["settable"] = true }
    guard depth < maxDepth, budget > 0 else { return n }
    var kids: [[String: Any]] = []
    for c in children(e) { if budget <= 0 { break }; budget -= 1; kids.append(copy(c, depth + 1)) }
    if !kids.isEmpty { n["children"] = kids }
    return n
  }
  let windows = (attr(element, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  printJSON(["status": "ok", "windows": windows.map { copy($0, 0) }])
}

switch args.count > 1 ? args[1] : "" {
case "list":
  let days = max(1, intArg("--days", 30)), maxChats = max(1, intArg("--max-chats", 40)), maxMessages = max(1, intArg("--max-messages", 30))
  let apps = (arg("--apps") ?? "messages,whatsapp").split(separator: ",").map(String.init)
  var only: [String: String] = [:]
  if let chat = arg("--chat"), let colon = chat.firstIndex(of: ":") { only[String(chat[..<colon])] = String(chat[chat.index(after: colon)...]) }
  var out: [String: Any] = [:]
  for app in ["messages", "whatsapp"] {
    if !apps.contains(app) || (!only.isEmpty && only[app] == nil) { out[app] = ["status": "off", "detail": "not asked for", "chats": [], "counts": ["chats": 0, "messages": 0, "newest": NSNull()]]; continue }
    out[app] = app == "messages" ? readMessages(days: days, maxChats: maxChats, maxMessages: maxMessages, onlyChat: only[app])
      : readWhatsApp(days: days, maxChats: maxChats, maxMessages: maxMessages, onlyChat: only[app])
  }
  printJSON(out)
case "composer": composerCommand(clear: false)
case "composer-clear": composerCommand(clear: true)
case "snapshot": snapshotCommand()
case "place": placeCommand()
default:
  fail("Usage: hikyaku-chats list [--days N] [--max-chats M] [--max-messages K] [--apps a,b] [--chat app:id] | composer --app a | composer-clear --app a | place --app a --title T --body-file F | snapshot --app a", 2)
}
