// electron-builder afterPack: an unsigned build (mac.identity null) still needs a valid ad-hoc seal, because Loggie adds
// Python, ffmpeg, the transcriber and the helpers to the app after Electron signed it, and an Apple Silicon Mac will not
// open an app whose seal no longer matches. A real signing identity (docs/release-signing.md) skips this: electron-builder
// signs every file in the app itself.
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (context.packager.platformSpecificBuildOptions.identity !== null) return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const entitlements = join(context.packager.projectDir, 'desktop', 'entitlements.mac.plist');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--entitlements', entitlements, app], { stdio: 'inherit' });
};
