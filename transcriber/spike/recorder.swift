// Spike: record a call on this Mac, both sides, no bot.
// System audio (the other side) -> them.caf, microphone (you) -> me.caf, until Ctrl-C or SIGTERM.
// SIGUSR1 pauses and SIGUSR2 resumes (2026-10-28): paused, each buffer is written as silence of the same length, so both
// sides keep their frame counts on the one clock, and pauses.json holds each pause in recording seconds.
//   recorder <output-dir> [--mic builtin]
import AVFoundation
import CoreAudio
import Foundation
import ScreenCaptureKit

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
  let dir: URL
  var files: [String: AVAudioFile] = [:]
  var frames: [String: Int64] = [:]
  // One clock for both sides (2026-10-28): an AirPods mic's first buffer came 6.16 s after the system audio's, and since
  // each file starts at its own first buffer every Me line was 6 s early. The late side starts with that much silence,
  // read off each buffer's presentation time (the host clock both outputs share). Over 60 s means the clocks disagree.
  static let maxPad = 60.0
  var origin: Double?                // the first buffer on either side, host seconds
  var timing: [String: [String: Double]] = [:]
  var mic: [String: Any] = [:]       // the mic's name, and mic_fallback when the built-in one was asked for and missing
  var paused = false                 // read and set on the audio queue only
  var pauses: [[String: Double]] = []
  init(dir: URL) { self.dir = dir }

  // Where the recording is, in seconds: the longer side, each at its own rate.
  func position() -> Double {
    frames.map { Double($0.value) / (timing[$0.key]?["rate"] ?? 48000) }.max() ?? 0
  }

  func setPaused(_ on: Bool) {
    guard on != paused else { return }
    paused = on
    let at = (position() * 100).rounded() / 100
    if on { pauses.append(["from_s": at]) } else if !pauses.isEmpty { pauses[pauses.count - 1]["to_s"] = at }
    if let json = try? JSONSerialization.data(withJSONObject: pauses, options: [.prettyPrinted, .sortedKeys]) {
      try? json.write(to: dir.appendingPathComponent("pauses.json"), options: .atomic)
    }
    print("\(on ? "paused" : "resumed") at \(at) s")
  }

  func silence(_ seconds: Double, as format: AVAudioFormat) -> AVAudioPCMBuffer? {
    guard let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(seconds * format.sampleRate)) else { return nil }
    pcm.frameLength = pcm.frameCapacity
    for b in UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList) { if let data = b.mData { memset(data, 0, Int(b.mDataByteSize)) } }
    return pcm
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .audio || type == .microphone, buffer.isValid,
          var description = buffer.formatDescription?.audioStreamBasicDescription,
          let format = AVAudioFormat(streamDescription: &description) else { return }
    let name = type == .audio ? "them" : "me"
    let count = AVAudioFrameCount(buffer.numSamples)
    guard let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count) else { return }
    pcm.frameLength = count
    guard CMSampleBufferCopyPCMDataIntoAudioBufferList(buffer, at: 0, frameCount: Int32(count), into: pcm.mutableAudioBufferList) == noErr else { return }
    if paused { for b in UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList) { if let data = b.mData { memset(data, 0, Int(b.mDataByteSize)) } } }
    do {
      if files[name] == nil {
        files[name] = try AVAudioFile(forWriting: dir.appendingPathComponent("\(name).caf"), settings: format.settings,
                                      commonFormat: format.commonFormat, interleaved: format.isInterleaved)
        let pts = buffer.presentationTimeStamp.seconds
        if origin == nil, pts.isFinite { origin = pts }
        let late = pts.isFinite ? pts - (origin ?? pts) : 0
        let pad = min(max(late, 0), Recorder.maxPad)
        if late > Recorder.maxPad { FileHandle.standardError.write("\(name) started \(late) s after the other side; padded \(pad) s only\n".data(using: .utf8)!) }
        if pad > 0.05, let quiet = silence(pad, as: format) {
          try files[name]!.write(from: quiet)
          frames[name, default: 0] += Int64(quiet.frameLength)
        }
        timing[name] = ["rate": format.sampleRate, "first_s": late, "host_s": pts.isFinite ? pts : 0, "padded_s": pad > 0.05 ? pad : 0]
        let all = timing.reduce(into: mic) { $0[$1.key] = $1.value }
        if let json = try? JSONSerialization.data(withJSONObject: all, options: [.prettyPrinted, .sortedKeys]) {
          try? json.write(to: dir.appendingPathComponent("timing.json"), options: .atomic)
        }
      }
      try files[name]!.write(from: pcm)
      frames[name, default: 0] += Int64(count)
    } catch {
      FileHandle.standardError.write("write failed for \(name): \(error)\n".data(using: .utf8)!)
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    FileHandle.standardError.write("recording stopped: \(error.localizedDescription)\n".data(using: .utf8)!)
    exit(1)
  }
}

// The MacBook's own microphone (2026-10-28): with AirPods connected macOS makes them the default input, and AirPods hear
// only Gio, so a class recorded on them loses the professor. `--mic builtin` asks for the built-in one by its transport.
func builtInMic() -> AVCaptureDevice? {
  AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone], mediaType: .audio, position: .unspecified).devices
    .first { $0.transportType == Int32(bitPattern: kAudioDeviceTransportTypeBuiltIn) }
}

@main
struct Main {
  static func main() async {
    var args = Array(CommandLine.arguments.dropFirst()), want: String?
    if let i = args.firstIndex(of: "--mic") {
      guard i + 1 < args.count else { print("usage: recorder <output-dir> [--mic builtin]"); exit(2) }
      want = args[i + 1]; args.removeSubrange(i...(i + 1))
    }
    guard let path = args.first, want == nil || want == "builtin" else { print("usage: recorder <output-dir> [--mic builtin]"); exit(2) }
    let dir = URL(fileURLWithPath: path)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
      guard let display = content.displays.first else { print("no display to attach audio capture to"); exit(3) }
      let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
      let config = SCStreamConfiguration()
      config.capturesAudio = true
      config.captureMicrophone = true
      config.excludesCurrentProcessAudio = true
      config.sampleRate = 48000
      config.channelCount = 1
      config.width = 2
      config.height = 2
      config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
      let recorder = Recorder(dir: dir)
      // No built-in mic found: the default input records, and timing.json says so. A recording is never refused for it.
      let builtin = want == "builtin" ? builtInMic() : nil
      if let device = builtin { config.microphoneCaptureDeviceID = device.uniqueID }
      recorder.mic["mic"] = (builtin ?? AVCaptureDevice.default(for: .audio))?.localizedName ?? "default input"
      if want == "builtin" && builtin == nil {
        recorder.mic["mic_fallback"] = true
        FileHandle.standardError.write("no built-in microphone found; recording the default input\n".data(using: .utf8)!)
      }
      let stream = SCStream(filter: filter, configuration: config, delegate: recorder)
      let queue = DispatchQueue(label: "audio")
      try stream.addStreamOutput(recorder, type: .audio, sampleHandlerQueue: queue)
      try stream.addStreamOutput(recorder, type: .microphone, sampleHandlerQueue: queue)
      try await stream.startCapture()
      print("recording to \(dir.path) - Ctrl-C to stop")
      for sig in [SIGINT, SIGTERM] {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler {
          Task {
            try? await stream.stopCapture()
            queue.sync { recorder.setPaused(false) }   // a stop while paused closes the pause
            // Each side at its own rate (2026-10-28): the AirPods mic records at 24 kHz, and / 48000 printed half its length.
            let seconds = Dictionary(uniqueKeysWithValues: recorder.frames.map { ($0.key, Double($0.value) / (recorder.timing[$0.key]?["rate"] ?? 48000)) })
            print("stopped: \(seconds)")
            exit(0)
          }
        }
        source.resume()
        sources.append(source)
      }
      for (sig, on) in [(SIGUSR1, true), (SIGUSR2, false)] {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler { queue.async { recorder.setPaused(on) } }
        source.resume()
        sources.append(source)
      }
      while true { try await Task.sleep(nanoseconds: 1_000_000_000) }
    } catch {
      print("could not start recording: \(error.localizedDescription)")
      exit(4)
    }
  }
  nonisolated(unsafe) static var sources: [DispatchSourceSignal] = []
}
