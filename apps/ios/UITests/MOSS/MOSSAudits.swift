import XCTest

@MainActor
final class MOSSAudits: XCTestCase {
    func testDefaultSize() throws { try AuditRunner.run(bundleID: "com.waifucave.moss.ios", size: nil, in: self) }
    func testLargestAccessibilitySize() throws { try AuditRunner.run(bundleID: "com.waifucave.moss.ios", size: "UICTContentSizeCategoryAXXXL", in: self) }
}
