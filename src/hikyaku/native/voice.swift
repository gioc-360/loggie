import Foundation
import Speech
import AVFoundation
func emit(_ data: [String: String]) {
    if let bytes = try? JSONSerialization.data(withJSONObject: data), let line = String(data: bytes, encoding: .utf8) { print(line); fflush(stdout) }
}
func fail(_ message: String, permission: String = "") -> Never { emit(["error": message, "permission": permission]); exit(1) }
let engine = AVAudioEngine()
var task: SFSpeechRecognitionTask?
var request: SFSpeechAudioBufferRecognitionRequest?
var finishing = false
func finish() {
    guard !finishing else { return }; finishing = true
    engine.stop(); request?.endAudio()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { emit(["status": "stopped"]); exit(0) }
}
func start() {
    guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else { fail("Speech recognition is unavailable for this Mac's language. Check your language and internet connection.") }
    guard recognizer.supportsOnDeviceRecognition else { fail("On-device speech is unavailable for this language. Enable/download your language in macOS Dictation settings, or use Fn twice in the text box.") }
    let audio = SFSpeechAudioBufferRecognitionRequest()
    audio.shouldReportPartialResults = true
    audio.requiresOnDeviceRecognition = true
    request = audio
    let node = engine.inputNode
    let format = node.outputFormat(forBus: 0)
    guard format.sampleRate > 0 && format.channelCount > 0 else { fail("No microphone is available. Connect a microphone and try again.") }
    node.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in audio.append(buffer) }
    task = recognizer.recognitionTask(with: audio) { result, error in
        if let result = result { emit(["text": result.bestTranscription.formattedString]); if result.isFinal { finish() } }
        if let error = error, !finishing { fail("Speech recognition stopped: \(error.localizedDescription)") }
    }
    do { engine.prepare(); try engine.start(); emit(["status": "listening"]) }
    catch { fail("Microphone could not start: \(error.localizedDescription)") }
    DispatchQueue.main.asyncAfter(deadline: .now() + 60) { finish() }
}
SFSpeechRecognizer.requestAuthorization { status in
    guard status == .authorized else { fail("Allow Loggie in System Settings → Privacy & Security → Speech Recognition, then try again.", permission: "speech") }
    AVCaptureDevice.requestAccess(for: .audio) { allowed in
        guard allowed else { fail("Allow Loggie in System Settings → Privacy & Security → Microphone, then try again.", permission: "microphone") }
        if CommandLine.arguments.contains("--authorize") { emit(["status": "permissions-granted"]); exit(0) }
        DispatchQueue.main.async { start() }
    }
}
DispatchQueue.global().async { while let line = readLine() { if line == "stop" { DispatchQueue.main.async { finish() }; return } }; DispatchQueue.main.async { finish() } }
RunLoop.main.run()
