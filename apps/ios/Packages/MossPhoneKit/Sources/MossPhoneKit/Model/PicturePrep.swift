import UIKit

/// A picture readied for `session.stageImage` as the desktop readies one (protocol `methods.ts`): its bytes go
/// UNCHANGED when they fit what one staging request carries; only a picture over that is scaled down (its long edge to
/// `maxLongEdge`) and written again as JPEG. One the phone can't read as a picture, or that is still too big, is refused.
public enum PicturePrep {
    /// `STAGE_IMAGE_MAX_BYTES`: the most a staged picture may weigh (what one request line carries).
    public static let maxBytes = 6_094_848
    /// `IMAGE_ATTACH_MAX_LONG_EDGE`: the long edge a picture that doesn't fit is scaled to.
    public static let maxLongEdge: CGFloat = 1568

    public enum Refusal: Error, Equatable { case notAPicture, tooLarge }

    /// The bytes to stage, and a small thumbnail for the chip.
    public static func prepare(_ data: Data, maxBytes: Int = maxBytes) throws -> (data: Data, thumbnail: Data) {
        guard let image = UIImage(data: data) else { throw Refusal.notAPicture }
        let thumb = image.preparingThumbnail(of: CGSize(width: 168, height: 168))?.pngData() ?? Data()
        if data.count <= maxBytes { return (data, thumb) }
        let size = image.size, long = max(size.width, size.height)
        let scale = long > maxLongEdge ? maxLongEdge / long : 1
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat.default(); format.scale = 1
        let smaller = UIGraphicsImageRenderer(size: target, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
        guard let out = smaller.jpegData(compressionQuality: 0.85), out.count <= maxBytes else { throw Refusal.tooLarge }
        return (out, thumb)
    }
}
