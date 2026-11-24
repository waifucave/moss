// Draws the two app icons (opaque, full-bleed 1024 squares: iOS rounds the corners itself).
// MOSS: the coral bot tile of apps/moss/build/icon.svg (coral, two ink eyes). MOSS Code: the Shards mark on Night.
// Run: swift Scripts/make-icons.swift <repo root> <apps/ios dir>
import AppKit

let args = CommandLine.arguments
let root = args[1], out = args[2]
let S: CGFloat = 1024

func render(_ draw: (CGContext) -> Void, to path: String) {
    let c = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    draw(c)
    let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, c.makeImage()!, nil)
    precondition(CGImageDestinationFinalize(dest))
}
func color(_ hex: UInt32) -> CGColor {
    CGColor(red: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: 1)
}

// MOSS: the tile's interior is coral; the eyes sit as in the svg (the tile is 824 wide, the eyes at 0.29 and 0.65 across).
render({ c in
    c.setFillColor(color(0xF0694C)); c.fill(CGRect(x: 0, y: 0, width: S, height: S))
    c.setFillColor(color(0x1B1D2B))
    c.fillEllipse(in: CGRect(x: 0.27 * S, y: 0.40 * S, width: 0.17 * S, height: 0.22 * S))
    c.fillEllipse(in: CGRect(x: 0.56 * S, y: 0.40 * S, width: 0.17 * S, height: 0.22 * S))
}, to: out + "/Apps/MOSS/Assets.xcassets/AppIcon.appiconset/icon.png")

// MOSS Code: parse the mark's M/L/Z polylines, fit them into the middle of the Night tile.
let svg = try! String(contentsOfFile: root + "/assets/brand/moss-code/mark/shards-mark-on-dark.svg", encoding: .utf8)
var paths: [[CGPoint]] = []
let dRegex = try! NSRegularExpression(pattern: #" d="([^"]+)""#)
for m in dRegex.matches(in: svg, range: NSRange(svg.startIndex..., in: svg)) {
    let d = String(svg[Range(m.range(at: 1), in: svg)!])
    var cur: [CGPoint] = []
    let scanner = d.replacingOccurrences(of: "M", with: " M ").replacingOccurrences(of: "L", with: " L ").replacingOccurrences(of: "Z", with: " Z ")
    var tokens = scanner.split(whereSeparator: { $0 == " " || $0 == "," }).map(String.init)
    var i = 0
    while i < tokens.count {
        let t = tokens[i]
        if t == "M" || t == "L" { cur.append(CGPoint(x: Double(tokens[i + 1])!, y: Double(tokens[i + 2])!)); i += 3 }
        else if t == "Z" { if !cur.isEmpty { paths.append(cur); cur = [] }; i += 1 }
        else { i += 1 }
    }
    if !cur.isEmpty { paths.append(cur) }
    tokens.removeAll()
}
render({ c in
    c.setFillColor(color(0x161A33)); c.fill(CGRect(x: 0, y: 0, width: S, height: S))
    // the mark's viewBox is 86 86 828 828; draw it at 62% of the tile
    let side = 0.62 * S, k = side / 828, o = (S - side) / 2
    c.setFillColor(color(0xE5A72E))
    for p in paths {
        c.beginPath()
        for (i, q) in p.enumerated() {
            let pt = CGPoint(x: o + (q.x - 86) * k, y: S - (o + (q.y - 86) * k))
            i == 0 ? c.move(to: pt) : c.addLine(to: pt)
        }
        c.closePath(); c.fillPath()
    }
}, to: out + "/Apps/MOSSCode/Assets.xcassets/AppIcon.appiconset/icon.png")
print("icons drawn")
