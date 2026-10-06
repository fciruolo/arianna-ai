import assert from 'node:assert/strict';
import { test } from 'node:test';

import { headIconPng } from '../../hud/characters/originals.ts';
import { iconFiles, infoPlist, loopbackUrl, serverUrl } from '../src/bundle.ts';

test('the helper talks to loopback only, by scheme, host and port', () => {
  assert.equal(loopbackUrl('http://127.0.0.1:7420'), 'http://127.0.0.1:7420');
  assert.equal(loopbackUrl('http://localhost:5173/'), 'http://localhost:5173');
  assert.equal(serverUrl('127.0.0.1', 7420), 'http://127.0.0.1:7420');
  assert.equal(serverUrl('::1', 7420), 'http://[::1]:7420');
  for (const bad of ['https://127.0.0.1:7420', 'http://192.168.1.2:7420', 'http://evil.example', 'http://127.0.0.1:7420/c/x', 'http://u:p@127.0.0.1:1', 'niente']) {
    assert.throws(() => loopbackUrl(bad), Error, bad);
  }
});

test('Info.plist: the name of Arianna, no Dock icon, the two addresses', () => {
  const plist = infoPlist({ server: 'http://127.0.0.1:7420', chat: 'http://127.0.0.1:5173', version: '0.13.0' });
  assert.match(plist, /<key>CFBundleName<\/key>\n {2}<string>Arianna<\/string>/);
  assert.match(plist, /<key>LSUIElement<\/key>\n {2}<true\/>/);
  assert.match(plist, /<key>AriannaServer<\/key>\n {2}<string>http:\/\/127\.0\.0\.1:7420<\/string>/);
  assert.match(plist, /<key>AriannaChat<\/key>\n {2}<string>http:\/\/127\.0\.0\.1:5173<\/string>/);
  assert.throws(() => infoPlist({ server: 'http://evil.example', chat: 'http://127.0.0.1:1', version: '1' }));
});

test('the iconset: every size iconutil wants, each a head the renderer can centre', () => {
  const files = iconFiles();
  assert.equal(files.length, 10);
  assert.deepEqual(files.map((file) => file.size), [16, 32, 32, 64, 128, 256, 256, 512, 512, 1024]);
  assert.ok(files.some((file) => file.name === 'icon_512x512@2x.png'));
  for (const file of files) {
    const png = headIconPng(file.size, file.scale);
    // PNG signature, then the width in the IHDR chunk.
    assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
    assert.equal(png.readUInt32BE(16), file.size, file.name);
  }
});
