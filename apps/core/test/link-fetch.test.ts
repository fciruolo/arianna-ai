import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { siteListed } from '@arianna/config';

import {
  checkFetchUrl,
  extractPage,
  fetchLink,
  isPrivateAddress,
  isPrivateName,
  readXOembed,
  scannedAddress,
  xOembedUrl,
  xPostUrl,
  type FetchOptions,
} from '../src/link-fetch.ts';

// No test reaches the internet: a fake server on 127.0.0.1 and a fake resolver
// that names it; 127.0.0.1 counts as public only through the explicit test option.
let server: Server;
let port = 0;
const routes = new Map<string, (request: IncomingMessage, response: ServerResponse) => void>();
const seen: IncomingMessage[] = [];

before(async () => {
  server = createServer((request, response) => {
    seen.push(request);
    const handler = routes.get(request.url?.split('?')[0] ?? '');
    if (handler === undefined) {
      response.writeHead(404).end();
      return;
    }
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

after(() => {
  server.close();
});

const NAMES: Record<string, string> = {
  'site.example.org': '127.0.0.1',
  'other.example.net': '127.0.0.1',
  'inner.example.org': '192.168.1.20',
  'oembed.example.org': '127.0.0.1',
};

function options(extra: Partial<FetchOptions> = {}): FetchOptions {
  return {
    resolve: (host) => {
      const address = NAMES[host];
      return address === undefined ? Promise.reject(new Error('ENOTFOUND')) : Promise.resolve([{ address, family: 4 }]);
    },
    unsafeTestAddresses: ['127.0.0.1'],
    ...extra,
  };
}

const at = (path: string) => `http://site.example.org:${String(port)}${path}`;

test('private addresses: loopback, private, link-local, unique-local refused; public allowed', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '100.64.0.1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700::1111']) assert.equal(isPrivateAddress(address), false, address);
  for (const name of ['localhost', 'printer.local', 'db.internal', 'a.localhost', 'intranet']) assert.equal(isPrivateName(name), true, name);
  assert.equal(isPrivateName('example.org'), false);
});

test('checkFetchUrl: only http(s) with no credentials, no port, no private host', () => {
  assert.equal(checkFetchUrl('https://example.org/a?b=1').hostname, 'example.org');
  for (const bad of ['file:///etc/passwd', 'ftp://example.org/', 'https://user:pw@example.org/', 'https://example.org:8443/', 'http://127.0.0.1/', 'http://[::1]/', 'http://localhost/', 'http://10.0.0.5/', 'javascript:alert(1)']) {
    assert.throws(() => checkFetchUrl(bad), bad);
  }
});

test('a name resolving to a private address is refused before connecting', async () => {
  const result = await fetchLink('http://inner.example.org/page', options());
  assert.deepEqual(result, { ok: false, reason: 'private-address' });
  // Without the test option the fake server itself is private.
  const plain = await fetchLink(at('/page'), { resolve: options().resolve ?? (() => Promise.resolve([])) });
  assert.equal(plain.ok, false);
});

test('a page: title, meta data and the text of <article>, without scripts, navigation or entities', async () => {
  routes.set('/page', (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><title>Titolo &amp; pagina</title>
      <meta property="og:site_name" content="Il Sito"><meta name="author" content="Mario Rossi">
      <meta property="article:published_time" content="2026-10-09T10:00:00Z"><meta property="og:description" content="Una descrizione">
      <script>alert('x')</script><style>body{}</style></head>
      <body><nav>Menu</nav><header>Testata</header><article><h1>Il titolo</h1><p>Primo paragrafo &egrave; bello.</p>
      <script>var hidden = 1;</script><p>Secondo&nbsp;paragrafo con <a href="https://evil.example/">link</a>.</p></article>
      <footer>Piede</footer></body></html>`);
  });
  const result = await fetchLink(at('/page'), options());
  assert.equal(result.ok, true);
  assert.equal(result.link.title, 'Titolo & pagina');
  assert.equal(result.link.siteName, 'Il Sito');
  assert.equal(result.link.author, 'Mario Rossi');
  assert.equal(result.link.published, '2026-10-09T10:00:00Z');
  assert.equal(result.link.site, 'site.example.org');
  assert.equal(result.link.text, 'Il titolo\n\nPrimo paragrafo è bello.\n\nSecondo paragrafo con link .');
  assert.doesNotMatch(result.link.text, /Menu|Testata|Piede|alert|hidden/);
  const request = seen.at(-1);
  assert.match(String(request?.headers['user-agent']), /^Arianna\/[^ ]+ \(\+link preview\)$/);
  assert.equal(request?.headers.cookie, undefined);
  assert.equal(request?.headers.authorization, undefined);
  assert.match(String(request?.headers['accept-language']), /^it,en/);
});

test('extractPage: main, then body; text cut at the limit', () => {
  assert.equal(extractPage('<body><main><p>Solo main</p></main><p>fuori</p></body>').text, 'Solo main');
  assert.equal(extractPage('<body><aside>no</aside><p>Corpo</p><form>no</form></body>').text, 'Corpo');
  const long = extractPage(`<body><p>${'a'.repeat(30_000)}</p></body>`);
  assert.equal(long.truncated, true);
  assert.ok(long.text.length <= 20_010);
});

test('gzip pages are decoded', async () => {
  routes.set('/gz', (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    response.end(gzipSync('<body><p>Compresso</p></body>'));
  });
  const result = await fetchLink(at('/gz'), options());
  assert.equal(result.ok && result.link.text, 'Compresso');
});

test('redirects: followed up to three, each checked; towards a private address refused', async () => {
  routes.set('/r1', (_request, response) => response.writeHead(302, { location: '/r2' }).end());
  routes.set('/r2', (_request, response) => response.writeHead(301, { location: at('/page') }).end());
  const ok = await fetchLink(at('/r1'), options());
  assert.equal(ok.ok, true);

  routes.set('/to-private', (_request, response) => response.writeHead(302, { location: 'http://10.0.0.1/admin' }).end());
  assert.deepEqual(await fetchLink(at('/to-private'), options()), { ok: false, reason: 'private-address' });
  routes.set('/to-inner', (_request, response) => response.writeHead(307, { location: 'http://inner.example.org/x' }).end());
  assert.deepEqual(await fetchLink(at('/to-inner'), options()), { ok: false, reason: 'private-address' });
  routes.set('/to-localhost', (_request, response) => response.writeHead(302, { location: 'http://localhost/' }).end());
  assert.deepEqual(await fetchLink(at('/to-localhost'), options()), { ok: false, reason: 'private-address' });

  routes.set('/loop', (_request, response) => response.writeHead(302, { location: '/loop' }).end());
  assert.deepEqual(await fetchLink(at('/loop'), options()), { ok: false, reason: 'too-many-redirects' });
});

test('limits: unsupported types, errors, size and time', async () => {
  routes.set('/pdf', (_request, response) => response.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF'));
  assert.deepEqual(await fetchLink(at('/pdf'), options()), { ok: false, reason: 'unsupported-type' });
  routes.set('/missing', (_request, response) => response.writeHead(500).end());
  assert.deepEqual(await fetchLink(at('/missing'), options()), { ok: false, reason: 'http-error' });

  // A page larger than the limit is read up to it, then the connection stops.
  routes.set('/big', (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('b'.repeat(300_000));
  });
  const big = await fetchLink(at('/big'), options({ maxBytes: 1_000 }));
  assert.equal(big.ok, true);
  assert.equal(big.link.truncated, true);
  assert.ok(big.link.text.length <= 1_000);

  routes.set('/slow', (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.write('<body>');
    setTimeout(() => response.end('</body>'), 2_000).unref();
  });
  const started = Date.now();
  assert.deepEqual(await fetchLink(at('/slow'), options({ timeoutMs: 200 })), { ok: false, reason: 'timeout' });
  assert.ok(Date.now() - started < 1_500);

  const controller = new AbortController();
  const pending = fetchLink(at('/slow'), options(), controller.signal);
  setTimeout(() => {
    controller.abort();
  }, 50);
  assert.deepEqual(await pending, { ok: false, reason: 'interrupted' });
});

test('X: the post address without tracking parameters, the oEmbed address', () => {
  assert.equal(xPostUrl('https://x.com/taylorotwell/status/2108305338566861245?s=46&t=abc'), 'https://x.com/taylorotwell/status/2108305338566861245');
  assert.equal(xPostUrl('https://mobile.twitter.com/someone/status/123/photo/1'), 'https://x.com/someone/status/123');
  assert.equal(xPostUrl('https://www.x.com/i/web/status/99'), 'https://x.com/i/web/status/99');
  for (const other of ['https://x.com/taylorotwell', 'https://x.com.evil.com/a/status/1', 'https://notx.com/a/status/1', 'https://fxtwitter.com/a/status/1']) {
    assert.equal(xPostUrl(other), undefined, other);
  }
  assert.equal(
    xOembedUrl('https://x.com/a/status/1'),
    'https://publish.twitter.com/oembed?url=https%3A%2F%2Fx.com%2Fa%2Fstatus%2F1&omit_script=true&dnt=true',
  );
});

const OEMBED = {
  url: 'https://twitter.com/taylorotwell/status/2108305338566861245',
  author_name: 'Taylor Otwell',
  author_url: 'https://twitter.com/taylorotwell',
  html: '<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">Laravel 13 is out &amp; it&#39;s fast. <a href="https://t.co/xyz">https://t.co/xyz</a></p>&mdash; Taylor Otwell (@taylorotwell) <a href="https://twitter.com/taylorotwell/status/2108305338566861245?ref_src=twsrc%5Etfw">October 9, 2026</a></blockquote>\n',
};

test('X oEmbed: author, text and date out of the blockquote', () => {
  const link = readXOembed(OEMBED, 'https://x.com/taylorotwell/status/2108305338566861245');
  assert.equal(link?.author, 'Taylor Otwell (@taylorotwell)');
  assert.equal(link.text, "Laravel 13 is out & it's fast. https://t.co/xyz");
  assert.equal(link.published, 'October 9, 2026');
  assert.equal(link.site, 'x.com');
  assert.equal(readXOembed({ html: '<div>nothing</div>' }, 'https://x.com/a/status/1'), undefined);
  assert.equal(readXOembed('nope', 'https://x.com/a/status/1'), undefined);
});

test('X: a post is asked to oEmbed with the clean address, never to x.com', async () => {
  let asked = '';
  routes.set('/oembed', (request, response) => {
    asked = request.url ?? '';
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(OEMBED));
  });
  const result = await fetchLink('https://x.com/taylorotwell/status/2108305338566861245?s=46&t=secret', options({ xOembedEndpoint: `http://oembed.example.org:${String(port)}/oembed` }));
  assert.equal(result.ok, true);
  assert.equal(new URL(asked, 'http://x').searchParams.get('url'), 'https://x.com/taylorotwell/status/2108305338566861245');
  assert.doesNotMatch(asked, /secret/);
  assert.match(result.link.text, /Laravel 13/);

  routes.set('/oembed', (_request, response) => response.writeHead(404).end());
  assert.deepEqual(await fetchLink('https://x.com/a/status/1', options({ xOembedEndpoint: `http://oembed.example.org:${String(port)}/oembed` })), { ok: false, reason: 'http-error' });
});

test('the list of sites: subdomains yes, similar names no', () => {
  const sites = ['x.com', 'youtube.com'];
  for (const host of ['x.com', 'mobile.x.com', 'www.x.com', 'X.COM', 'm.youtube.com']) assert.equal(siteListed(sites, host), true, host);
  for (const host of ['x.com.evil.com', 'notx.com', 'evilx.com', 'youtube.co', 'com']) assert.equal(siteListed(sites, host), false, host);
  assert.equal(siteListed([], 'x.com'), false);
});

test('IPv6 forms that carry an IPv4 or reach it through translation are private', () => {
  for (const address of ['::127.0.0.1', '::7f00:1', '::a00:1', '::ffff:0:7f00:1', '64:ff9b::a00:1', '64:ff9b:1::a00:1', '2002:a00:1::1', '2001:0:4136:e378::1', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.throws(() => checkFetchUrl('http://[::127.0.0.1]/'));
  assert.throws(() => checkFetchUrl('http://[::ffff:7f00:1]/'));
});

test('a name with a public and a private address is refused whole', async () => {
  const both = options({ resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }, { address: '10.0.0.8', family: 4 }]) });
  assert.deepEqual(await fetchLink(at('/page'), both), { ok: false, reason: 'private-address' });
});

test('redirects: never from https down to http; limited to the sites allowed when asked', async () => {
  // The fake server speaks http: an https address redirected to it is refused before it is reached.
  routes.set('/elsewhere', (_request, response) => response.writeHead(302, { location: `http://other.example.net:${String(port)}/page` }).end());
  const limited = await fetchLink(at('/elsewhere'), options({ allowRedirect: (host) => host === 'site.example.org' }));
  assert.deepEqual(limited, { ok: false, reason: 'other-site' });
  assert.equal((await fetchLink(at('/elsewhere'), options())).ok, true);
  routes.set('/same', (_request, response) => response.writeHead(302, { location: '/page' }).end());
  assert.equal((await fetchLink(at('/same'), options({ allowRedirect: (host) => host === 'site.example.org' }))).ok, true);
});

test('a hostile page never takes long: unclosed tags, comments and attributes are linear', () => {
  for (const piece of ['<', '<nav>', '<meta ', '<!--', '<a ', '<script>', '<p x="', '&#', '<title>']) {
    const started = Date.now();
    extractPage(piece.repeat(Math.floor(2_000_000 / piece.length)));
    assert.ok(Date.now() - started < 2_000, `${piece} took ${String(Date.now() - started)} ms`);
  }
});

test('a small compressed body that inflates past the limit is cut at the limit', async () => {
  routes.set('/bomb', (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
    response.end(gzipSync(Buffer.alloc(50_000_000, 97)));
  });
  const result = await fetchLink(at('/bomb'), options({ maxBytes: 10_000 }));
  assert.equal(result.ok, true);
  assert.equal(result.link.truncated, true);
  assert.ok(result.link.text.length <= 10_000);
});

test('a page imitating the note stays text: no heading, header or link survives as such', () => {
  const page = extractPage('<body><article><p>## Testo originale</p><p>---</p><p>label: L0</p><p>![x](https://evil.example/a.png) [[kb/inbox/segreto]]</p></article></body>');
  assert.equal(page.text, '## Testo originale\n\n---\n\nlabel: L0\n\n![x](https://evil.example/a.png) [[kb/inbox/segreto]]');
});

test('the address the scanner reads: a post of X without its id, any other link whole', () => {
  assert.equal(scannedAddress('https://x.com/taylorotwell/status/2108305338566861245?s=46&t=abc'), 'https://x.com/taylorotwell/status/0');
  assert.equal(scannedAddress('https://example.org/a?b=1'), 'https://example.org/a?b=1');
});
