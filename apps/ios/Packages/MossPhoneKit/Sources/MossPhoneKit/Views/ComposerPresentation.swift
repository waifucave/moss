import SwiftUI
import UIKit

/// A non-modal floating attachment menu in the existing app view hierarchy. It stays above
/// the keyboard's layout guide, leaving the original text field and real keyboard untouched.
struct ComposerAttachmentPresentation<Content: View>: UIViewRepresentable {
    @Binding var isPresented: Bool
    let isExpanded: Bool
    @ViewBuilder let content: () -> Content
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> AnchorView {
        let view = AnchorView()
        view.isUserInteractionEnabled = false
        view.didLayout = { [weak coordinator = context.coordinator] in
            coordinator?.refresh()
        }
        return view
    }

    func updateUIView(_ view: AnchorView, context: Context) {
        let coordinator = context.coordinator
        coordinator.anchor = view
        coordinator.isPresented = isPresented
        coordinator.isExpanded = isExpanded
        coordinator.style = colorScheme == .dark ? .dark : .light
        coordinator.content = AnyView(content()
            .environment(\.colorScheme, colorScheme)
            .environment(\.dynamicTypeSize, dynamicTypeSize)
            .foregroundStyle(.primary)
            .tint(Theme.accent)
            .accessibilityAction(.escape) { isPresented = false })
        coordinator.onDismiss = {
            withAnimation(.snappy(duration: 0.2)) { isPresented = false }
        }
        coordinator.refresh(updateContent: true)
    }

    static func dismantleUIView(_ view: AnchorView, coordinator: Coordinator) {
        view.didLayout = nil
        coordinator.tearDown()
    }

    final class AnchorView: UIView {
        var didLayout: (() -> Void)?
        override func layoutSubviews() {
            super.layoutSubviews()
            didLayout?()
        }
        override func didMoveToWindow() {
            super.didMoveToWindow()
            didLayout?()
        }
    }

    final class OverlayController: UIViewController {
        var onResize: (() -> Void)?
        var onLayout: (() -> Void)?

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            onLayout?()
        }

        override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
            super.viewWillTransition(to: size, with: coordinator)
            // Close during a scene rotation/resize; reopening uses the new anchor geometry.
            onResize?()
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        weak var anchor: AnchorView?
        var isPresented = false
        var isExpanded = false
        var style: UIUserInterfaceStyle = .unspecified
        var content = AnyView(EmptyView())
        var onDismiss: (() -> Void)?
        private var overlayController: OverlayController?
        private var host: UIHostingController<AnyView>?
        private var sourceRect: CGRect = .zero
        private var openedExpanded = false
        private var isClosing = false
        private var isOpening = false

        func refresh(updateContent: Bool = false) {
            guard isPresented else {
                dismiss()
                return
            }
            guard let anchor, let sourceWindow = anchor.window,
                  !anchor.bounds.isEmpty else { return }

            if overlayController == nil {
                guard var presenter = sourceWindow.rootViewController else { return }
                while let presented = presenter.presentedViewController { presenter = presented }
                let controller = OverlayController()
                controller.onResize = { [weak self] in self?.onDismiss?() }
                controller.onLayout = { [weak self] in
                    guard let self, !self.isOpening, !self.isClosing else { return }
                    self.placeCard(animateFromSource: false)
                }
                controller.overrideUserInterfaceStyle = style
                controller.view.backgroundColor = .clear
                controller.view.frame = presenter.view.bounds
                controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                controller.view.clipsToBounds = true
                controller.view.keyboardLayoutGuide.followsUndockedKeyboard = true
                openedExpanded = isExpanded
                controller.view.accessibilityViewIsModal = true
                let tap = UITapGestureRecognizer(target: self, action: #selector(outsideTapped))
                tap.delegate = self
                controller.view.addGestureRecognizer(tap)

                let host = UIHostingController(rootView: content)
                host.safeAreaRegions = []
                host.view.backgroundColor = .clear
                controller.addChild(host)
                controller.view.addSubview(host.view)
                host.didMove(toParent: controller)
                self.host = host
                self.overlayController = controller
                // Containment, not modal presentation or a new key window: never resign the
                // composer's first responder and never snapshot/replace the system keyboard.
                isOpening = true
                presenter.addChild(controller)
                presenter.view.addSubview(controller.view)
                controller.didMove(toParent: presenter)
                controller.view.layoutIfNeeded()
                placeCard(animateFromSource: true)
            } else {
                if updateContent { host?.rootView = content }
                overlayController?.overrideUserInterfaceStyle = style
                if isClosing {
                    isClosing = false
                    host?.view.layer.removeAllAnimations()
                }
                if !isOpening { placeCard(animateFromSource: false) }
            }
        }

        private func placeCard(animateFromSource: Bool) {
            guard let anchor, let container = overlayController?.view, let host else { return }
            let source = anchor.convert(anchor.bounds, to: container)
            sourceRect = source
            let bounds = container.bounds
            let insets = container.safeAreaInsets
            let margin: CGFloat = 12
            let width = min(280, bounds.width - insets.left - insets.right - margin * 2)
            // The guide includes the keyboard's accessory/prediction region. When hidden it
            // collapses to the bottom safe area, so the resting layout remains unchanged.
            let keyboard = container.keyboardLayoutGuide.layoutFrame
            let keyboardVisible = keyboard.height > insets.bottom + 1 && keyboard.intersects(bounds)
            let bottom = min(bounds.maxY - insets.bottom - margin,
                             keyboardVisible ? keyboard.minY - 8 : bounds.maxY)
            let availableHeight = max(1, bottom - insets.top - margin)
            let size = host.sizeThatFits(in: CGSize(width: width, height: availableHeight))
            let height = min(size.height, availableHeight)
            let left = min(max(source.minX - 8, insets.left + margin),
                           bounds.maxX - insets.right - margin - width)
            // Keep the existing anchoring, moving the focused card only as far upward as
            // needed to leave an 8 pt gap above the keyboard. At rest, open from the pill.
            let preferredTop = openedExpanded ? source.midY + 12 - height / 2 : source.maxY - height
            let top = min(max(preferredTop, insets.top + margin),
                          bottom - height)
            let center = CGPoint(x: left + width / 2, y: top + height / 2)
            host.view.bounds = CGRect(origin: .zero, size: CGSize(width: width, height: height))

            if animateFromSource && !UIAccessibility.isReduceMotionEnabled {
                host.view.center = CGPoint(x: source.midX, y: source.midY)
                host.view.transform = CGAffineTransform(scaleX: source.width / width,
                                                       y: source.height / height)
                host.view.alpha = 0
                UIView.animate(withDuration: 0.3, delay: 0, usingSpringWithDamping: 0.86,
                               initialSpringVelocity: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
                    host.view.center = center
                    host.view.transform = .identity
                    host.view.alpha = 1
                } completion: { [weak self] _ in
                    guard let self else { return }
                    self.isOpening = false
                    if !self.isClosing { self.placeCard(animateFromSource: false) }
                }
            } else {
                host.view.center = center
                host.view.transform = .identity
                host.view.alpha = 1
                isOpening = false
            }
        }

        private func dismiss() {
            guard let host, !isClosing else { return }
            isClosing = true
            let source = sourceRect
            UIView.animate(withDuration: UIAccessibility.isReduceMotionEnabled ? 0 : 0.2,
                           delay: 0, options: [.beginFromCurrentState]) {
                if !host.view.bounds.isEmpty {
                    host.view.center = CGPoint(x: source.midX, y: source.midY)
                    host.view.transform = CGAffineTransform(scaleX: source.width / host.view.bounds.width,
                                                           y: source.height / host.view.bounds.height)
                }
                host.view.alpha = 0
            } completion: { [weak self] _ in
                guard let self, self.isClosing else { return }
                self.tearDown()
            }
        }

        func tearDown() {
            overlayController?.onLayout = nil
            overlayController?.onResize = nil
            overlayController?.willMove(toParent: nil)
            overlayController?.view.removeFromSuperview()
            overlayController?.removeFromParent()
            overlayController = nil
            host = nil
            isClosing = false
            isOpening = false
        }

        @objc private func outsideTapped() { onDismiss?() }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            // Outside app-content taps and the card's rounded corners dismiss without
            // activating the transcript/composer. The real keyboard remains independently usable.
            guard let host else { return true }
            let shape = UIBezierPath(roundedRect: host.view.bounds, cornerRadius: 48)
            return !shape.contains(touch.location(in: host.view))
        }
    }
}

/// The composer's card material: neutral interactive glass and the gutters. The question box wears the same, so the composer
/// and the question are two pieces of one material.
struct ComposerChrome: ViewModifier {
    /// Gutters, parametrized for the focus choreography: at rest the compact pill floats with a
    /// narrower width and 6 pt bottom breath; with the keyboard up the composer widens to 8 pt
    /// sides and retains a small 8 pt lift above the keyboard. Non-composer wearers (the question
    /// box) keep the resting values.
    var horizontal: CGFloat = 16
    var bottom: CGFloat = 6
    var radius: CGFloat = 22

    func body(content: Content) -> some View {
        // Neutral interactive glass, no tint: it adapts only to what is behind it and to the appearance.
        content
            .glassEffect(.regular.interactive(), in: .rect(cornerRadius: radius, style: .continuous))
            .padding(.horizontal, horizontal)
            .padding(.bottom, bottom)
    }
}
