import SwiftUI
import UIKit

/// An agent's mark, as the desktop draws it: the shipped mark where one is in `AgentMarks.xcassets`, else the first letter of
/// its name on its colour.
public struct AgentMarkView: View {
    let backend: String?
    let size: CGFloat
    public init(backend: String?, size: CGFloat = 28) { self.backend = backend; self.size = size }

    public var body: some View {
        let look = AgentLook.of(backend)
        Group {
            if look.id.isEmpty == false, UIImage(named: look.id, in: .module, with: nil) != nil {
                Image(look.id, bundle: .module)
                    .renderingMode(look.template ? .template : .original)
                    .resizable().scaledToFit()
                    .foregroundStyle(look.colorHex.map(Theme.color(hex:)) ?? Color.primary)
                    .padding(size * 0.14)
            } else {
                Text(look.initial)
                    .font(.system(size: size * 0.5, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(look.colorHex.map(Theme.color(hex:)) ?? Color.gray, in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement()
        .accessibilityLabel(look.name)
    }
}
