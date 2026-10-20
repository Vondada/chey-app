// CHE screen sharing (owner, 2026-10-20): the iOS broadcast upload extension
// that lets CHE see another app's screen. The owner starts it from the
// system sheet ("Start Broadcast"; a red indicator shows while it runs) and
// stops it there or from the status bar. While it runs, this extension
// writes a downscaled JPEG of the screen at most once a second into the App
// Group folder CHE shares with it, keeps the last few, and beats a heartbeat
// every two seconds. Nothing leaves the iPhone from here: CHE reads a frame
// only when the owner asks "look at my screen", and every frame is deleted
// when the broadcast stops.

import CoreImage
import ImageIO
import ReplayKit
import UIKit

enum CheBroadcastStore {
  static let defaultGroup = "group.com.cheyapp.chey"

  /// SideStore/AltStore rename the App Group when they sign the app and list
  /// the new name under ALTAppGroups; the declared name is the fallback.
  static var groupID: String {
    if let groups = Bundle.main.object(forInfoDictionaryKey: "ALTAppGroups") as? [String],
       let first = groups.first(where: { !$0.isEmpty }) {
      return first
    }
    return defaultGroup
  }

  static var folder: URL? {
    FileManager.default
      .containerURL(forSecurityApplicationGroupIdentifier: groupID)?
      .appendingPathComponent("che_screen", isDirectory: true)
  }
}

final class SampleHandler: RPBroadcastSampleHandler {
  private let context = CIContext(options: [.cacheIntermediates: false])
  private let queue = DispatchQueue(label: "com.cheyapp.che.broadcast")
  private var lastFrame = Date.distantPast
  private var heartbeat: DispatchSourceTimer?
  private var startedAt = Date()

  /// Frames kept, newest last, so CHE can pick the one from before the owner
  /// switched back to her.
  private static let keep = 8
  private static let maxSide: CGFloat = 1400

  override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
    startedAt = Date()
    guard let folder = CheBroadcastStore.folder else {
      finishBroadcastWithError(NSError(
        domain: "CHE", code: 1,
        userInfo: [NSLocalizedDescriptionKey: "CHE's shared folder is missing; this build cannot share the screen."]
      ))
      return
    }
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    clearFrames(in: folder)
    writeState(active: true)
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: 2.0)
    timer.setEventHandler { [weak self] in self?.writeState(active: true) }
    timer.resume()
    heartbeat = timer
  }

  override func broadcastFinished() {
    heartbeat?.cancel()
    heartbeat = nil
    queue.sync {
      if let folder = CheBroadcastStore.folder { clearFrames(in: folder) }
      writeState(active: false)
    }
  }

  override func broadcastPaused() { writeState(active: true, paused: true) }
  override func broadcastResumed() { writeState(active: true) }

  override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
    guard sampleBufferType == .video else { return }
    let now = Date()
    guard now.timeIntervalSince(lastFrame) >= 1.0,
          let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    lastFrame = now
    var image = CIImage(cvPixelBuffer: pixels)
    if let raw = CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber,
       let orientation = CGImagePropertyOrientation(rawValue: raw.uint32Value) {
      image = image.oriented(orientation)
    }
    let longest = max(image.extent.width, image.extent.height)
    if longest > Self.maxSide {
      let scale = Self.maxSide / longest
      image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    }
    let width = Int(image.extent.width.rounded())
    let height = Int(image.extent.height.rounded())
    queue.async { [weak self] in
      guard let self, let folder = CheBroadcastStore.folder,
            let space = CGColorSpace(name: CGColorSpace.sRGB),
            let jpeg = self.context.jpegRepresentation(
              of: image, colorSpace: space,
              options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.6]
            ) else { return }
      let stamp = Int64(now.timeIntervalSince1970 * 1000)
      let name = "frame-\(stamp)-\(width)x\(height).jpg"
      try? jpeg.write(to: folder.appendingPathComponent(name), options: .atomic)
      self.prune(folder)
    }
  }

  // MARK: - Files

  private func frames(in folder: URL) -> [URL] {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
    return names.filter { $0.hasPrefix("frame-") && $0.hasSuffix(".jpg") }.sorted().map { folder.appendingPathComponent($0) }
  }

  private func prune(_ folder: URL) {
    let all = frames(in: folder)
    for url in all.dropLast(Self.keep) { try? FileManager.default.removeItem(at: url) }
  }

  private func clearFrames(in folder: URL) {
    for url in frames(in: folder) { try? FileManager.default.removeItem(at: url) }
  }

  private func writeState(active: Bool, paused: Bool = false) {
    guard let folder = CheBroadcastStore.folder else { return }
    let state: [String: Any] = [
      "active": active,
      "paused": paused,
      "started_at": startedAt.timeIntervalSince1970,
      "heartbeat_at": Date().timeIntervalSince1970,
    ]
    if let data = try? JSONSerialization.data(withJSONObject: state) {
      try? data.write(to: folder.appendingPathComponent("state.json"), options: .atomic)
    }
  }
}
