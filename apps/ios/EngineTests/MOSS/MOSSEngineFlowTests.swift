import MossPhoneKit

/// MOSS hosts this bundle: the engine flow as MOSS runs it.
final class MOSSEngineFlowTests: EngineFlowTests {
    override class var app: MossPhoneKit.PhoneApp { .moss }
}
