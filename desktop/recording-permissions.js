// ScreenCaptureKit makes the authoritative screen/audio decision when the recorder starts.
// Electron's screen preflight can remain denied after a grant, so it must not block that attempt.
export function recordingPermissionGuard(guard, readStatus, createGuard, emit) {
  const recording = createGuard({ status: async () => ({ ...await readStatus(), screen: 'unknown' }), emit });
  return { check: (action, options) => (action === 'record' ? recording : guard).check(action, options) };
}
