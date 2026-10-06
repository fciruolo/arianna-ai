// pnpm notifier:build [--chat <address>] [--no-open]: the helper of the Mac
// (D-128) in data/notifier/Arianna.app, compiled from apps/notifier/Sources
// with swiftc of the Command Line Tools, signed ad hoc, registered and opened.
// Nothing is written outside data/; starting at login is added by the user.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_FILE, loadConfig, resolveHome } from '@arianna/config';

import { headIconPng } from '../../hud/characters/originals.ts';
import { iconFiles, infoPlist, loopbackUrl, serverUrl } from './bundle.ts';

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function run(file: string, args: string[]): void {
  const result = spawnSync(file, args, { stdio: 'inherit' });
  if (result.error !== undefined) {
    const missing = (result.error as NodeJS.ErrnoException).code === 'ENOENT';
    throw new Error(missing ? `${file} is missing: install the Command Line Tools with xcode-select --install` : `${file}: ${result.error.message}`);
  }
  if (result.status !== 0) throw new Error(`${file} ended with ${String(result.status)}`);
}

if (process.platform !== 'darwin') {
  console.error('notifier:build: the helper is a macOS app');
  process.exit(1);
}

const home = resolveHome();
if (!existsSync(join(home, CONFIG_FILE))) {
  console.error('notifier:build: config/arianna.toml is missing: run pnpm arianna:init');
  process.exit(1);
}
const config = loadConfig();
const server = serverUrl(config.server.host, config.server.port);
const chatOption = argument('--chat');
const chat = chatOption === undefined ? server : loopbackUrl(chatOption);
const version = (JSON.parse(readFileSync(join(home, 'package.json'), 'utf8')) as { version: string }).version;

const folder = join(config.paths.data, 'notifier');
const app = join(folder, 'Arianna.app');
const contents = join(app, 'Contents');
const iconset = join(folder, 'AppIcon.iconset');
try {
  rmSync(app, { recursive: true, force: true });
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(join(contents, 'MacOS'), { recursive: true });
  mkdirSync(join(contents, 'Resources'), { recursive: true });
  mkdirSync(iconset, { recursive: true });

  run('swiftc', ['-O', '-o', join(contents, 'MacOS', 'Arianna'), join(home, 'apps', 'notifier', 'Sources', 'Arianna.swift')]);
  writeFileSync(join(contents, 'Info.plist'), infoPlist({ server, chat, version }));
  for (const icon of iconFiles()) writeFileSync(join(iconset, icon.name), headIconPng(icon.size, icon.scale));
  run('iconutil', ['-c', 'icns', '-o', join(contents, 'Resources', 'AppIcon.icns'), iconset]);
  rmSync(iconset, { recursive: true, force: true });
  run('codesign', ['--force', '--sign', '-', app]);
  run(LSREGISTER, ['-f', app]);
  console.log(`Arianna.app in ${app} (core ${server}, chat ${chat})`);
  if (!process.argv.includes('--no-open')) run('open', [app]);
} catch (error) {
  console.error(`notifier:build: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
