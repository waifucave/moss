import Foundation

/// Motion as Reduce Motion asks: a person's own setting, or (in a Debug build only) `-stillMotion` for the accessibility
/// audit, so a screen that is moving (the turn's shimmering status line, a bot's face) holds still long enough to be read.
/// What a person sees is unchanged: a Release build reads no launch argument.
enum Motion {
    static let stillForTests: Bool = {
        #if DEBUG
        return ProcessInfo.processInfo.arguments.contains("-stillMotion")
        #else
        return false
        #endif
    }()
}
