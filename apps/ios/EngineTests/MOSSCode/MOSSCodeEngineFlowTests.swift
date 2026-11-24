import MossPhoneKit

/// MOSS Code hosts this bundle: the engine flow as MOSS Code runs it.
final class MOSSCodeEngineFlowTests: EngineFlowTests {
    override class var app: MossPhoneKit.PhoneApp { .code }
}
