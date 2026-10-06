// The app bundle of the helper of the Mac (D-128), as data: what
// `pnpm notifier:build` writes. Pure, so that it is tested without swiftc.

/** The addresses the helper may use: http on loopback only, as [server] of arianna.toml allows. */
export function loopbackUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`not an address: ${text}`);
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error(`not a loopback http address: ${text}`);
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') throw new Error(`only scheme, host and port: ${text}`);
  return `${url.protocol}//${url.host}`;
}

/** [server] as an address: an IPv6 host goes in brackets. */
export function serverUrl(host: string, port: number): string {
  return loopbackUrl(`http://${host.includes(':') ? `[${host}]` : host}:${String(port)}`);
}

const escapeXml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Info.plist: the name and icon of Arianna, no Dock icon (LSUIElement), the addresses of the core and of the chat. */
export function infoPlist(options: { server: string; chat: string; version: string }): string {
  const entries: [string, string | boolean][] = [
    ['CFBundleIdentifier', 'local.arianna.notifier'],
    ['CFBundleName', 'Arianna'],
    ['CFBundleDisplayName', 'Arianna'],
    ['CFBundleExecutable', 'Arianna'],
    ['CFBundleIconFile', 'AppIcon'],
    ['CFBundlePackageType', 'APPL'],
    ['CFBundleShortVersionString', options.version],
    ['CFBundleVersion', options.version],
    ['LSMinimumSystemVersion', '13.0'],
    ['LSUIElement', true],
    ['AriannaServer', loopbackUrl(options.server)],
    ['AriannaChat', loopbackUrl(options.chat)],
  ];
  const body = entries
    .map(([key, value]) => `  <key>${key}</key>\n  ${typeof value === 'boolean' ? (value ? '<true/>' : '<false/>') : `<string>${escapeXml(value)}</string>`}`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
}

/** The files of the iconset iconutil wants, with their size in pixels and the scale of the head (16 pixels wide). */
export function iconFiles(): { name: string; size: number; scale: number }[] {
  const sizes: [number, number][] = [
    [16, 1],
    [16, 2],
    [32, 1],
    [32, 2],
    [128, 1],
    [128, 2],
    [256, 1],
    [256, 2],
    [512, 1],
    [512, 2],
  ];
  return sizes.map(([points, factor]) => {
    const size = points * factor;
    // The head fills about seven eighths of the square, in whole pixels of art.
    const scale = Math.max(1, Math.floor((size * 7) / 8 / 16));
    return { name: `icon_${String(points)}x${String(points)}${factor === 2 ? '@2x' : ''}.png`, size, scale };
  });
}
