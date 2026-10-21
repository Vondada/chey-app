// CHE ReplayKit privacy guard.
// A screen broadcast can contain third-party passwords, recovery phrases or
// private account data. ReplayKit cannot reliably classify every frame.
// Until a reviewed on-device redaction and per-frame approval path exists,
// do not save, upload or expose cross-app frames, even in an App Group.
import ReplayKit
import CoreMedia
import Foundation

final class SampleHandler: RPBroadcastSampleHandler {
  override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
    finishBroadcastWithError(NSError(
      domain: "CHE.ScreenPrivacy", code: 1,
      userInfo: [NSLocalizedDescriptionKey:
        "For your privacy, cross-app screen sharing is unavailable in this CHE build. No screen image was saved or sent."]
    ))
  }

  override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
    // No serialization, persistent storage, network calls, or retained frames.
  }
}
