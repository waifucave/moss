import SwiftUI
import VisionKit
import AVFoundation

/// First run: scan the code shown on the computer, check the four words, confirm. The same screen in both apps.
public struct PairingScreen: View {
    @Bindable var model: PairingModel
    let appName: String
    let simulatedCamera: Bool
    let onPaired: (PairedComputer) -> Void

    public init(model: PairingModel, appName: String, simulatedCamera: Bool, onPaired: @escaping (PairedComputer) -> Void) {
        self.model = model; self.appName = appName; self.simulatedCamera = simulatedCamera; self.onPaired = onPaired
    }

    public var body: some View {
        NavigationStack {
            Group {
                switch model.step {
                case .scanning, .checking: scanStep
                case .confirming(let p): wordsStep(p)
                case .paired(let c): pairedStep(c)
                case .failed(let e): failedStep(e)
                }
            }
            .navigationTitle("Pair with your computer")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var scanStep: some View {
        VStack(spacing: 20) {
            Text("On your computer, open \(appName) and choose Pair a phone. Then point this camera at the code.")
                .font(.body).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal, 24)
            ZStack {
                RoundedRectangle(cornerRadius: 28, style: .continuous).fill(.background.secondary)
                if simulatedCamera {
                    VStack(spacing: 10) {
                        Image(systemName: "qrcode.viewfinder").font(.system(size: 64, weight: .thin)).foregroundStyle(.secondary)
                        Text("No camera here.").font(.footnote).foregroundStyle(.secondary)
                        Button("Use a sample code") { Task { await model.scanned("moss-pair:sample") } }
                            .buttonStyle(.bordered).tint(Theme.accent)
                    }
                } else {
                    CameraScanner { code in Task { await model.scanned(code) } }
                        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
                }
                if model.step == .checking { ProgressView().controlSize(.large).padding(24).glassEffect(.regular, in: .circle) }
            }
            .aspectRatio(1, contentMode: .fit)
            .padding(.horizontal, 32)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Camera for the pairing code")
            Spacer()
        }
        .padding(.top, 16)
    }

    private func wordsStep(_ p: PairingProposal) -> some View {
        VStack(spacing: 22) {
            Text("Do these four words match the ones on \(p.computer)?")
                .font(.title3.weight(.semibold)).multilineTextAlignment(.center).padding(.horizontal, 24)
            VStack(spacing: 10) {
                ForEach(Array(p.words.enumerated()), id: \.offset) { i, w in
                    HStack {
                        Text("\(i + 1)").font(.footnote.monospacedDigit()).foregroundStyle(.secondary).frame(width: 22)
                        Text(w).font(.system(.title2, design: .rounded, weight: .medium))
                        Spacer()
                    }
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(.background.secondary, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }
            .padding(.horizontal, 32)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("The four words: \(p.words.joined(separator: ", "))")
            Text("Only confirm if all four are the same.").font(.footnote).foregroundStyle(.secondary)
            Spacer()
            VStack(spacing: 10) {
                Button { Task { await model.confirm() } } label: { Text("They match").frame(maxWidth: .infinity).foregroundStyle(Color(uiColor: .systemBackground)) }
                    .buttonStyle(.borderedProminent).tint(Theme.accent).controlSize(.large)
                Button { Task { await model.cancel() } } label: { Text("They don't match").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered).tint(.secondary).controlSize(.large)
            }
            .padding(.horizontal, 24).padding(.bottom, 12)
        }
        .padding(.top, 20)
    }

    private func pairedStep(_ c: PairedComputer) -> some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "checkmark.circle").font(.system(size: 64, weight: .thin))
            Text("Paired with \(c.name)").font(.title2.weight(.semibold))
            Text("This phone can now see \(appName) and answer cards from it.").foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal, 32)
            Spacer()
            Button { onPaired(c) } label: { Text("Done").frame(maxWidth: .infinity).foregroundStyle(Color(uiColor: .systemBackground)) }
                .buttonStyle(.borderedProminent).tint(Theme.accent).controlSize(.large).padding(.horizontal, 24).padding(.bottom, 12)
        }
    }

    private func failedStep(_ e: PairingError) -> some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "exclamationmark.circle").font(.system(size: 56, weight: .thin)).foregroundStyle(.secondary)
            Text(e.message).multilineTextAlignment(.center).padding(.horizontal, 32)
            Spacer()
            Button { model.retry() } label: { Text("Try again").frame(maxWidth: .infinity).foregroundStyle(Color(uiColor: .systemBackground)) }
                .buttonStyle(.borderedProminent).tint(Theme.accent).controlSize(.large).padding(.horizontal, 24).padding(.bottom, 12)
        }
    }
}

/// The live camera, read for a QR code. Camera access is explained here first and asked for only when the person
/// presses Continue; no biometric or passcode prompt is ever involved.
struct CameraScanner: View {
    let onScan: (String) -> Void
    @State private var authorization = AVCaptureDevice.authorizationStatus(for: .video)

    var body: some View {
        if !DataScannerViewController.isSupported {
            note("Scanning isn't supported on this device.", icon: "xmark.circle")
        } else {
            switch authorization {
            case .authorized: Scanner(onScan: onScan)
            case .notDetermined:
                VStack(spacing: 12) {
                    Image(systemName: "camera").font(.system(size: 40, weight: .thin)).foregroundStyle(.secondary)
                    Text("The camera is only used to read the code. Nothing is recorded.").font(.footnote).multilineTextAlignment(.center).foregroundStyle(.secondary)
                    Button("Continue") { AVCaptureDevice.requestAccess(for: .video) { ok in Task { @MainActor in authorization = ok ? .authorized : .denied } } }
                        .buttonStyle(.bordered).tint(Theme.accent)
                }.padding()
            default:
                VStack(spacing: 12) {
                    note("Allow the camera in Settings to scan the code.", icon: "camera")
                    Button("Open Settings") { if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) } }
                        .buttonStyle(.bordered).tint(Theme.accent)
                }
            }
        }
    }
    private func note(_ text: String, icon: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: icon).font(.system(size: 40, weight: .thin)).foregroundStyle(.secondary)
            Text(text).font(.footnote).multilineTextAlignment(.center).foregroundStyle(.secondary)
        }.padding()
    }

    private struct Scanner: UIViewControllerRepresentable {
        let onScan: (String) -> Void
        func makeUIViewController(context: Context) -> DataScannerViewController {
            let c = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
                                              recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false,
                                              isPinchToZoomEnabled: false, isGuidanceEnabled: false, isHighlightingEnabled: true)
            c.delegate = context.coordinator
            if DataScannerViewController.isAvailable { try? c.startScanning() }
            return c
        }
        func updateUIViewController(_ c: DataScannerViewController, context: Context) {}
        static func dismantleUIViewController(_ c: DataScannerViewController, coordinator: Coordinator) { c.stopScanning() }
        func makeCoordinator() -> Coordinator { Coordinator(onScan) }
        final class Coordinator: NSObject, DataScannerViewControllerDelegate {
            let onScan: (String) -> Void
            var delivered = false
            init(_ f: @escaping (String) -> Void) { onScan = f }
            func dataScanner(_ s: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
                guard !delivered else { return }
                for case .barcode(let b) in items { if let v = b.payloadStringValue { delivered = true; onScan(v); return } }
            }
        }
    }
}
