// Recovery instructions shared by the Record UI and its checks.
export function recordingHelp({ blocked, error = '' } = {}) {
  if (/dyld|Library not loaded|built for macOS/i.test(error)) return { message: 'This recorder was built for a different macOS version. Install a compatible Loggie build. For a source preview, rebuild recorder.swift targeting macOS 15.0, then retry Record.', detail: error };
  if (/already recording/i.test(error)) return { message: 'A recording is already running. Open Notes & Meetings and stop that recording before starting another.', detail: error };
  if (blocked === 'microphone' || /microphone|mic permission/i.test(error)) return { message: 'Allow Loggie to use your microphone in System Settings → Privacy & Security → Microphone. For this preview, enable Electron, then retry Record.', permission: 'microphone' };
  if (blocked === 'screen' || /screen.*(?:audio|record|permission)|system audio|user declined|SCStreamErrorDomain/i.test(error)) return { message: 'Allow Loggie in System Settings → Privacy & Security → Screen & System Audio Recording. For this preview, enable Electron, reopen Loggie if macOS asks, then retry Record. If Electron is already enabled, fully quit and reopen Loggie; the recorder may need a fresh macOS permission prompt.', permission: 'screen', detail: error || undefined };
  if (blocked === 'speech') return { message: 'Speech files are still downloading. Wait for the download to finish, then retry Record.' };
  if (/recorder|python|no such file|ENOENT/i.test(error)) return { message: 'The recording component could not start. Reinstall the latest Loggie build, or check the recorder and Python setup for this source preview.', detail: error };
  return { message: 'Recording did not start. Retry Record; if it fails again, check Settings (the ⋯ menu) for microphone and screen audio permissions.', detail: error || undefined };
}
