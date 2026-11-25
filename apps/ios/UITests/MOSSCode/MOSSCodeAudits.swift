import XCTest

final class MOSSCodeAudits: XCTestCase {
    func testDefaultSize() throws { try AuditRunner.run(bundleID: "com.waifucave.moss.code.ios", size: nil, in: self) }
    func testLargestAccessibilitySize() throws { try AuditRunner.run(bundleID: "com.waifucave.moss.code.ios", size: "UICTContentSizeCategoryAXXXL", in: self) }
}
