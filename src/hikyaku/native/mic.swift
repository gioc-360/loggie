// hikyaku-mic: which processes have the microphone open right now. It lists processes and reads no audio.
// Prints {"at": ISO, "using_mic": [{"bundle": "us.zoom.xos", "pid": 1234}, ...]} and exits 0.
import CoreAudio
import Foundation

if CommandLine.arguments.count > 1 {
  FileHandle.standardError.write("usage: hikyaku-mic   (takes no arguments; prints the apps using the microphone as JSON)\n".data(using: .utf8)!)
  exit(2)
}

func read<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ value: inout T) -> OSStatus {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size = UInt32(MemoryLayout<T>.size)
  return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
}

var listAddress = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
var listSize: UInt32 = 0
AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &listAddress, 0, nil, &listSize)
var ids = [AudioObjectID](repeating: 0, count: Int(listSize) / MemoryLayout<AudioObjectID>.size)
AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &listAddress, 0, nil, &listSize, &ids)

var using: [[String: Any]] = []
for id in ids {
  var running: UInt32 = 0
  _ = read(id, kAudioProcessPropertyIsRunningInput, &running)
  if running == 0 { continue }
  var bundle: CFString = "" as CFString
  _ = read(id, kAudioProcessPropertyBundleID, &bundle)
  var pid: Int32 = 0
  _ = read(id, kAudioProcessPropertyPID, &pid)
  using.append(["bundle": bundle as String, "pid": Int(pid)])
}

let out: [String: Any] = ["at": ISO8601DateFormatter().string(from: Date()), "using_mic": using]
let data = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
