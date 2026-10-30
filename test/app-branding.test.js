// Check packaged branding resources and the removal of mascot-only UI/IPC, without changing user data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root));
test('macOS package points to a valid multi-size ICNS and high-resolution transparent Dock PNG', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(pkg.build.mac.icon, 'assets/branding/loggie.icns');
  const icns = await read(pkg.build.mac.icon);
  assert.equal(icns.toString('ascii', 0, 4), 'icns'); assert.equal(icns.readUInt32BE(4), icns.length);
  const formats = []; for (let p = 8; p < icns.length; p += icns.readUInt32BE(p + 4)) formats.push(icns.toString('ascii', p, p + 4));
  assert(formats.includes('ic10'), '1024px Retina representation');
  const png = await read('assets/branding/loggie-app.png');
  assert.equal(png.readUInt32BE(16), 1024); assert.equal(png.readUInt32BE(20), 1024);
  assert.equal(png[25], 6, 'RGBA PNG');
});
test('menu bar has matching 1x and 2x template assets', async () => {
  for (const [name, size] of [['loggie-tray.png', 18], ['loggie-tray@2x.png', 36]]) {
    const png = await read(`assets/branding/${name}`);
    assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size); assert.equal(png[25], 6);
  }
});
// The SVG is the logo's source (2026-10-28, thinner bars); build:icons draws both logo PNGs from it at these sizes.
test('the logo SVG has a square viewBox and the logo PNGs keep their sizes', async () => {
  const svg = (await read('assets/branding/loggie-logo.svg')).toString();
  const [, , w, h] = svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
  assert.equal(w, h); assert.doesNotMatch(svg, /<rect|<image/);
  for (const [path, width, height] of [['assets/branding/loggie-logo.png', 689, 748], ['desktop/renderer/marks/loggie-logo.png', 236, 256]]) {
    const png = await read(path);
    assert.equal(png.readUInt32BE(16), width); assert.equal(png.readUInt32BE(20), height); assert.equal(png[25], 6, `${path} is RGBA`);
  }
});
test('retired mascot window, animation, images and IPC do not ship', async () => {
  for (const path of ['desktop/renderer/companion.html', 'desktop/renderer/companion.js', 'desktop/renderer/mascot-state.js', 'assets/idle.png', 'assets/sleeping.png', 'assets/happy.png', 'assets/excited.png']) {
    await assert.rejects(access(new URL(path, root)), { code: 'ENOENT' });
  }
  const html = (await read('desktop/renderer/panel.html')).toString();
  const preload = (await read('desktop/preload.cjs')).toString();
  const main = (await read('desktop/main.js')).toString();
  assert.doesNotMatch(html, /id="collapse"|Return to companion/);
  assert.doesNotMatch(preload, /companion|collapse-panel/i);
  assert.doesNotMatch(main, /createCompanionWindow|companionWindow/);
});
