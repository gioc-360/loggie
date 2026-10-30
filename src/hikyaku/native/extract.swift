// Extracts plain text from one PDF or Word file for hikyaku. It is run inside a macOS sandbox that allows no network,
// reads only its input and writes only its output (src/hikyaku/extract.js). Apple's own readers: PDFKit for PDF,
// AppKit for Word, the same engine as `textutil`; neither runs macros. Caps: 50 pages, 200,000 characters.
//   extract <input> <output> <pdf|word>     prints one JSON line: {"status": ok|partial|locked|unreadable, "detail"}
import AppKit
import Foundation
import PDFKit

let maxPages = 50, maxChars = 200_000
let args = CommandLine.arguments
func emit(_ status: String, _ detail: String) {
  let line = ["status": status, "detail": detail]
  if let data = try? JSONSerialization.data(withJSONObject: line), let text = String(data: data, encoding: .utf8) { print(text) }
}
guard args.count == 4, ["pdf", "word"].contains(args[3]) else { emit("unreadable", "usage: extract <input> <output> <pdf|word>"); exit(2) }
let input = URL(fileURLWithPath: args[1]), output = URL(fileURLWithPath: args[2])
var text = "", pages = 0, partial = false

if args[3] == "pdf" {
  guard let document = PDFDocument(url: input) else { emit("unreadable", "not a readable PDF"); exit(0) }
  if document.isLocked { emit("locked", "the PDF is password-protected"); exit(0) }
  pages = document.pageCount
  // Pages are separated by a form feed (the pdftotext convention), so an excerpt can name the page it quotes.
  for index in 0..<min(pages, maxPages) {
    if let page = document.page(at: index)?.string { text += page + "\n\u{0C}" }
    if text.count > maxChars { break }
  }
  partial = pages > maxPages
} else {
  // Document type is pinned to Word or RTF, never HTML: the HTML importer could try to load remote content.
  let types: [NSAttributedString.DocumentType] = [.officeOpenXML, .docFormat, .rtf, .openDocument]
  var read: NSAttributedString? = nil
  for type in types where read == nil {
    read = try? NSAttributedString(url: input, options: [.documentType: type], documentAttributes: nil)
  }
  guard let document = read else { emit("unreadable", "not a readable Word document"); exit(0) }
  text = document.string
}
// A scanned PDF has pages but no text layer; say so rather than call an empty read "ok".
if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { emit("no-text", "no text inside: probably a scanned image (not read)"); exit(0) }
if text.count > maxChars { partial = true }
let kept = String(text.prefix(maxChars))
do { try kept.write(to: output, atomically: false, encoding: .utf8) } catch { emit("unreadable", "could not write the text"); exit(0) }
emit(partial ? "partial" : "ok", "\(kept.count) characters" + (pages > 0 ? ", \(min(pages, maxPages)) of \(pages) pages" : ""))
