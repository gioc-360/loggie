#!/bin/bash
# Rebuild the logo PNGs, app and template icons from assets/branding/loggie-logo.svg, using only macOS tools.
set -euo pipefail
icon_repo_root="$(cd "$(dirname "$0")/.." && pwd)"
icon_output="$icon_repo_root/assets/branding"
icon_scratch="$(mktemp -d "${TMPDIR:-/tmp}/loggie-icons.XXXXXX")"
trap 'rm -rf "$icon_scratch"' EXIT

# The SVG is the logo's one source (2026-10-28, thinner bars): its L, cropped to its own box, fills each PNG at the
# size the app already uses, on a transparent background.
swift - "$icon_output/loggie-logo.svg" "$icon_output/loggie-logo.png" "$icon_repo_root/desktop/renderer/marks/loggie-logo.png" <<'SWIFT'
import AppKit
let a = CommandLine.arguments
let svg = NSImage(contentsOfFile: a[1])!
func bitmap(_ w: Int, _ h: Int, _ draw: () -> Void) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: w, height: h)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current!.imageInterpolation = .high
    draw()
    NSGraphicsContext.restoreGraphicsState()
    return rep
}
let side = 2048
let big = bitmap(side, side) { svg.draw(in: NSRect(x: 0, y: 0, width: side, height: side)) }
var (x0, y0, x1, y1) = (side, side, -1, -1)
let px = big.bitmapData!, row = big.bytesPerRow
for y in 0..<side { for x in 0..<side where px[y * row + x * 4 + 3] > 127 {
    x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y)
} }
let box = NSRect(x: x0, y: side - 1 - y1, width: x1 - x0 + 1, height: y1 - y0 + 1)
let ink = NSImage(size: NSSize(width: side, height: side)); ink.addRepresentation(big)
for (path, w, h, margin) in [(a[2], 689, 748, 2.0), (a[3], 236, 256, 1.0)] {
    let k = min((CGFloat(w) - 2 * margin) / box.width, (CGFloat(h) - 2 * margin) / box.height)
    let to = NSRect(x: (CGFloat(w) - box.width * k) / 2, y: (CGFloat(h) - box.height * k) / 2, width: box.width * k, height: box.height * k)
    let rep = bitmap(w, h) { ink.draw(in: to, from: box, operation: .copy, fraction: 1) }
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}
SWIFT

swift - "$icon_output" "$icon_scratch" <<'SWIFT'
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let output = URL(fileURLWithPath: CommandLine.arguments[1])
let scratch = URL(fileURLWithPath: CommandLine.arguments[2])
let source = CGImageSourceCreateWithURL(output.appendingPathComponent("loggie-logo.png") as CFURL, nil)!
let logo = CGImageSourceCreateImageAtIndex(source, 0, nil)!
func save(_ image: CGImage, _ url: URL) {
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, nil)
    precondition(CGImageDestinationFinalize(dest), "Could not write \(url.path)")
}
func icon(_ size: Int, inset: CGFloat, template: Bool = false) -> CGImage {
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.interpolationQuality = .high
    let available = CGFloat(size) - inset * 2
    let factor = available / CGFloat(max(logo.width, logo.height))
    let width = CGFloat(logo.width) * factor, height = CGFloat(logo.height) * factor
    context.draw(logo, in: CGRect(x: (CGFloat(size) - width) / 2, y: (CGFloat(size) - height) / 2, width: width, height: height))
    if template {
        context.setBlendMode(.sourceIn)
        context.setFillColor(CGColor(gray: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: size, height: size))
    }
    return context.makeImage()!
}
save(icon(1024, inset: 96), output.appendingPathComponent("loggie-app.png"))
save(icon(18, inset: 1, template: true), output.appendingPathComponent("loggie-tray.png"))
save(icon(36, inset: 2, template: true), output.appendingPathComponent("loggie-tray@2x.png"))
let set = scratch.appendingPathComponent("loggie.iconset")
try FileManager.default.createDirectory(at: set, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let suffix = scale == 2 ? "@2x" : ""
        save(icon(pixels, inset: CGFloat(pixels) * 96 / 1024), set.appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
    }
}
SWIFT
iconutil --convert icns "$icon_scratch/loggie.iconset" --output "$icon_output/loggie.icns"
echo "Built Loggie Dock, app and Retina menu bar icons in $icon_output"
