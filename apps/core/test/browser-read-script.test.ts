import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { asksLogin, LOGIN_SCRIPT, parseReading, READ_SCRIPT, type PageReading } from '../src/browser/agent-browser.ts';
import { ELEMENTS_KEY, readingText } from '../src/orchestrator/browser-tool.ts';

/**
 * READ_SCRIPT and LOGIN_SCRIPT on pages made of plain objects (D-287): the
 * scripts use only parents, children, attributes, boxes and computed styles,
 * so a small fake of the DOM is enough to run them without a browser.
 */

interface Spec {
  tag: string;
  attrs?: Record<string, string>;
  text?: string;
  /** left, top, width, height; a default box on screen otherwise. */
  box?: [number, number, number, number];
  style?: Record<string, string>;
  children?: Spec[];
}

class FakeElement {
  readonly tagName: string;
  readonly attributes: Record<string, string>;
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  readonly style: Record<string, string>;
  readonly ownText: string;
  readonly rect: [number, number, number, number];
  readonly labels = null;
  readonly form = null;

  constructor(spec: Spec) {
    this.tagName = spec.tag.toUpperCase();
    this.attributes = { ...spec.attrs };
    this.style = spec.style ?? {};
    this.ownText = spec.text ?? '';
    this.rect = spec.box ?? [10, 10, 100, 20];
    for (const child of spec.children ?? []) {
      const element = new FakeElement(child);
      element.parentElement = this;
      this.children.push(element);
    }
  }

  get innerText(): string {
    return [this.ownText, ...this.children.map((child) => child.innerText)].filter((part) => part !== '').join(' ');
  }

  get href(): string | undefined {
    return this.attributes.href;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  removeAttribute(name: string): void {
    // A dynamic delete only on a record made here for the test.
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete this.attributes[name];
  }

  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    const [left, top, width, height] = this.rect;
    return { left, top, right: left + width, bottom: top + height, width, height };
  }
}

const INTERACTIVE = ['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY'];
/** The roles the selectors of the scripts take (a dialog or a search landmark is none of them). */
const ROLES = ['button', 'link', 'textbox', 'searchbox'];

function all(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap((child) => all(child))];
}

/** Runs a script of the core on a page made of `body`: what it returns, as a plain object of this realm. */
function run(script: string, body: Spec[]): unknown {
  const html = new FakeElement({ tag: 'html', children: [{ tag: 'body', children: body }] });
  const root = html.children[0];
  assert.ok(root !== undefined);
  const elements = all(html);
  const document = {
    title: 'Pagina finta',
    body: root,
    documentElement: { scrollHeight: 800, scrollWidth: 1280 },
    querySelectorAll: (selector: string) =>
      selector.startsWith('[data-arianna-ref')
        ? elements.filter((element) => element.getAttribute('data-arianna-ref') !== null)
        : elements.filter((element) => (INTERACTIVE.includes(element.tagName) && (element.tagName !== 'A' || element.href !== undefined)) || ROLES.includes(element.getAttribute('role') ?? '')),
    querySelector: () => elements.find((element) => element.tagName === 'MAIN' || element.tagName === 'ARTICLE' || element.getAttribute('role') === 'main') ?? null,
  };
  const getComputedStyle = (element: FakeElement) => ({ visibility: 'visible', display: 'block', opacity: '1', overflowX: 'visible', overflowY: 'visible', ...element.style });
  const result: unknown = runInNewContext(script, { document, window: { innerHeight: 800, innerWidth: 1280, scrollX: 0, scrollY: 0 }, location: { href: 'https://cerca-finta.it/?q=ferramenta' }, getComputedStyle });
  return JSON.parse(JSON.stringify(result)) as unknown;
}

function read(body: Spec[]): PageReading {
  return parseReading(run(READ_SCRIPT, body));
}

function loginOn(body: Spec[]): boolean {
  return asksLogin(parseReading(run(LOGIN_SCRIPT, body)));
}

/** A search engine without landmarks around its logo (as DuckDuckGo): the results are articles with a heading link. */
const SEARCH_PAGE: Spec[] = [
  {
    tag: 'div',
    attrs: { class: 'header-wrap' },
    children: [
      { tag: 'a', attrs: { href: 'https://cerca-finta.it/' }, text: 'Cerca Finta' },
      { tag: 'form', attrs: { role: 'search' }, children: [{ tag: 'input', attrs: { type: 'text', name: 'q', 'aria-label': 'Cerca' } }, { tag: 'button', text: 'Cerca' }] },
    ],
  },
  {
    tag: 'section',
    children: [
      { tag: 'article', children: [{ tag: 'h2', children: [{ tag: 'a', attrs: { href: 'https://ferramenta-finta.it/' }, text: 'Ferramenta Finta' }] }, { tag: 'a', attrs: { href: 'https://ferramenta-finta.it/chi-siamo' }, text: 'Chi siamo' }] },
      { tag: 'article', children: [{ tag: 'a', attrs: { href: 'https://utensili-finti.it/' }, children: [{ tag: 'h2', text: 'Utensili Finti' }] }] },
    ],
  },
];

test('READ_SCRIPT marks the results of a search as title links of the main content, the logo without marks (D-287)', () => {
  const reading = read(SEARCH_PAGE);
  const byLabel = new Map(reading.elements.map((element) => [element.label, element]));
  assert.deepEqual(byLabel.get('Cerca Finta'), { ref: 1, kind: 'link', label: 'Cerca Finta', href: 'https://cerca-finta.it/' });
  assert.deepEqual(byLabel.get('Ferramenta Finta'), { ref: 4, kind: 'link', label: 'Ferramenta Finta', href: 'https://ferramenta-finta.it/', area: 'main', heading: true });
  assert.equal(byLabel.get('Chi siamo')?.heading, undefined);
  assert.equal(byLabel.get('Chi siamo')?.area, 'main');
  // A link that holds the heading counts as a title too.
  assert.equal(byLabel.get('Utensili Finti')?.heading, true);
  // The search box and its button are in a form.
  assert.equal(byLabel.get('Cerca')?.form, 0);
  const text = readingText(reading);
  assert.ok(text.includes(ELEMENTS_KEY));
  assert.match(text, /\[1\] link «Cerca Finta» → cerca-finta\.it\n/);
  assert.match(text, /\[4\] link «Ferramenta Finta» → ferramenta-finta\.it \(title, main content\)/);
});

test('READ_SCRIPT: header, menu and footer of the page; a header inside an article is of the article (D-287)', () => {
  const reading = read([
    { tag: 'header', children: [{ tag: 'a', attrs: { href: 'https://negozio-finto.it/' }, text: 'Logo' }, { tag: 'nav', children: [{ tag: 'a', attrs: { href: 'https://negozio-finto.it/prodotti' }, text: 'Prodotti' }] }] },
    { tag: 'main', children: [{ tag: 'article', children: [{ tag: 'header', children: [{ tag: 'h1', children: [{ tag: 'a', attrs: { href: 'https://negozio-finto.it/viti' }, text: 'Viti' }] }] }] }] },
    { tag: 'aside', children: [{ tag: 'a', attrs: { href: 'https://negozio-finto.it/offerte' }, text: 'Offerte' }] },
    { tag: 'footer', children: [{ tag: 'a', attrs: { href: 'https://negozio-finto.it/privacy' }, text: 'Privacy' }] },
  ]);
  assert.deepEqual(
    reading.elements.map((element) => [element.label, element.area, element.heading]),
    [
      ['Logo', 'header', undefined],
      ['Prodotti', 'nav', undefined],
      ['Viti', 'main', true],
      ['Offerte', 'aside', undefined],
      ['Privacy', 'footer', undefined],
    ],
  );
  // A page without landmarks: no marks, no key.
  const plain = read([{ tag: 'a', attrs: { href: 'https://negozio-finto.it/' }, text: 'Home' }]);
  assert.ok(!readingText(plain).includes(ELEMENTS_KEY));
});

/** A shop: search box and link «Accedi» in the header, a cookie banner, a mini login closed in a box of height 0. */
const SHOP_PAGE: Spec[] = [
  {
    tag: 'header',
    children: [
      { tag: 'form', children: [{ tag: 'input', attrs: { type: 'text', placeholder: 'Cerca prodotti' } }, { tag: 'button', text: 'Cerca' }] },
      { tag: 'a', attrs: { href: 'https://ferramenta-finta.it/login' }, text: 'Accedi' },
      {
        tag: 'div',
        box: [900, 60, 300, 0],
        style: { overflowX: 'hidden', overflowY: 'hidden' },
        children: [{ tag: 'form', box: [900, 60, 300, 200], children: [{ tag: 'input', attrs: { type: 'email', placeholder: 'Email' }, box: [910, 70, 280, 30] }, { tag: 'input', attrs: { type: 'password', placeholder: 'Password' }, box: [910, 110, 280, 30] }, { tag: 'button', text: 'Accedi', box: [910, 150, 100, 30] }] }],
      },
    ],
  },
  { tag: 'div', attrs: { role: 'dialog' }, children: [{ tag: 'button', text: 'Accetta tutti' }, { tag: 'button', text: 'Rifiuta' }] },
  { tag: 'main', children: [{ tag: 'h1', text: 'Ferramenta Finta' }] },
];

test('LOGIN_SCRIPT: a shop with a link «Accedi», a search box, a cookie banner and a closed mini login is no login page (D-287)', () => {
  assert.equal(loginOn(SHOP_PAGE), false);
  // Arianna's reading does not list the password field cut away either.
  assert.ok(!read(SHOP_PAGE).elements.some((element) => element.kind === 'password'));
  assert.equal(asksLogin(read(SHOP_PAGE)), false);
  // A fixed dialog inside a header that cuts: on screen, so a login (the overflow does not hold it).
  assert.equal(loginOn([{ tag: 'header', box: [0, 0, 1280, 0], style: { overflowY: 'hidden' }, children: [{ tag: 'div', style: { position: 'fixed' }, box: [400, 200, 400, 300], children: [{ tag: 'input', attrs: { type: 'password' }, box: [420, 260, 300, 30] }] }] }]), true);
  // A box that scrolls does not cut: its password field is listed.
  assert.equal(loginOn([{ tag: 'div', box: [0, 0, 300, 100], style: { overflowY: 'auto' }, children: [{ tag: 'input', attrs: { type: 'password' }, box: [10, 400, 280, 30] }] }]), true);
  // A password field hidden with display: none.
  assert.equal(loginOn([{ tag: 'form', children: [{ tag: 'input', attrs: { type: 'password' }, style: { display: 'none' } }] }]), false);
});

test('LOGIN_SCRIPT: a real login form, and the first page of a login in two steps (D-287)', () => {
  assert.equal(loginOn([{ tag: 'main', children: [{ tag: 'form', children: [{ tag: 'input', attrs: { type: 'email', placeholder: 'Email' } }, { tag: 'input', attrs: { type: 'password', placeholder: 'Password' } }, { tag: 'button', text: 'Accedi' }] }] }]), true);
  assert.equal(loginOn([{ tag: 'form', children: [{ tag: 'input', attrs: { type: 'text', 'aria-label': 'Nome utente' } }, { tag: 'input', attrs: { type: 'submit', value: 'Accedi' } }] }]), true);
  // The same mini login, open: on screen.
  assert.equal(loginOn([{ tag: 'div', box: [900, 60, 300, 200], style: { overflowY: 'hidden' }, children: [{ tag: 'form', children: [{ tag: 'input', attrs: { type: 'password' }, box: [910, 110, 280, 30] }] }] }]), true);
});

test('LOGIN_SCRIPT never reads the value of a field nor leaves numbers on the page (D-287)', () => {
  assert.doesNotMatch(LOGIN_SCRIPT, /\.value\b/);
  assert.doesNotMatch(LOGIN_SCRIPT, /setAttribute/);
});

/** A shop whose real login form sits in a drop-down parked off the page (ferramentalombardi.it, 2026-10-22: x = -9296). */
function parkedLogin(left: number, top = 200): Spec[] {
  return [
    { tag: 'header', children: [{ tag: 'a', attrs: { href: 'https://ferramenta-finta.it/login' }, text: 'Accedi' }] },
    {
      tag: 'div',
      box: [left, top, 247, 271],
      children: [
        {
          tag: 'form',
          attrs: { action: 'ajax_login.php' },
          box: [left, top, 247, 271],
          children: [
            { tag: 'input', attrs: { type: 'text', name: 'uname', placeholder: 'Username' }, box: [left + 10, top + 20, 220, 30] },
            { tag: 'input', attrs: { type: 'password', name: 'upassword' }, box: [left + 10, top + 60, 220, 30] },
            { tag: 'button', attrs: { type: 'submit' }, text: 'LOGIN', box: [left + 10, top + 100, 100, 30] },
          ],
        },
      ],
    },
    { tag: 'main', children: [{ tag: 'h1', text: 'Ferramenta Finta' }] },
  ];
}

test('a login form parked outside the document is hidden: no login page, nothing of it in the reading (D-287)', () => {
  for (const page of [parkedLogin(-9999), parkedLogin(-9296), parkedLogin(100, -900), parkedLogin(5000)]) {
    assert.equal(loginOn(page), false);
    const reading = read(page);
    assert.ok(!reading.elements.some((element) => element.kind === 'password' || element.label === 'LOGIN' || element.label === 'Username'));
    assert.equal(asksLogin(reading), false);
  }
  // The same form on screen: a login page, both for the screen and for Arianna's reading.
  const visible = parkedLogin(400);
  assert.equal(loginOn(visible), true);
  assert.equal(asksLogin(read(visible)), true);
});
