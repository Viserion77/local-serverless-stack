// The dashboard's message catalogues and the locale resolution around them.
// The UI itself is exercised by vue-tsc and by hand, but two things have to
// hold mechanically. First, every key exists in every language: a key added to
// `en` alone renders as English inside an otherwise translated screen — the
// kind of gap nobody notices until a user who does not read English hits it.
// Second, the resolution chain that picks a language for a first-time visitor
// (stored choice → browser languages → English) and puts it on `<html lang>`,
// because nothing downstream can recover from getting that wrong.
//
// Importing the catalogues here is safe: `messages/index.ts` pulls only the
// per-area files, and its `Locale` import is type-only, so no Vue runtime is
// dragged into the Node test environment.
import { MESSAGES } from '../../../src/ui/src/i18n/messages';
import { LOCALES, DEFAULT_LOCALE, matchLocale, detectLocale } from '../../../src/ui/src/i18n';

const TRANSLATED = LOCALES.filter(locale => locale !== DEFAULT_LOCALE);

describe('message catalogues', () => {
  it('ship every locale the app offers', () => {
    expect(Object.keys(MESSAGES).sort()).toEqual([...LOCALES].sort());
  });

  it('carry a non-trivial number of keys (a broken merge would silently empty them)', () => {
    expect(Object.keys(MESSAGES[DEFAULT_LOCALE]).length).toBeGreaterThan(200);
  });

  it.each(TRANSLATED)('%s has exactly the same keys as English', (locale) => {
    const english = Object.keys(MESSAGES[DEFAULT_LOCALE]).sort();
    expect(Object.keys(MESSAGES[locale]).sort()).toEqual(english);
  });

  it.each(TRANSLATED)('%s has no empty or untranslated-by-copy-paste blanks', (locale) => {
    const blank = Object.entries(MESSAGES[locale])
      .filter(([, value]) => value.trim() === '')
      .map(([key]) => key);
    expect(blank).toEqual([]);
  });

  it('namespaces every key by its area file', () => {
    // `queues.title`, never a bare `title` — areas own their key space, which
    // is what keeps two screens from clobbering each other.
    const unnamespaced = Object.keys(MESSAGES[DEFAULT_LOCALE]).filter(key => !key.includes('.'));
    expect(unnamespaced).toEqual([]);
  });

  it('keeps interpolation placeholders identical across languages', () => {
    // A translation that drops `{count}` renders a sentence with a hole in it;
    // one that invents `{total}` renders the literal braces.
    const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    for (const [key, english] of Object.entries(MESSAGES[DEFAULT_LOCALE])) {
      for (const locale of TRANSLATED) {
        expect({ key, locale, params: placeholders(MESSAGES[locale][key] ?? '') })
          .toEqual({ key, locale, params: placeholders(english) });
      }
    }
  });
});

describe('locale matching', () => {
  it('takes an exact tag', () => {
    expect(matchLocale('pt-BR')).toBe('pt-BR');
    expect(matchLocale('es')).toBe('es');
    expect(matchLocale('en')).toBe('en');
  });

  it('falls back to the language subtag', () => {
    expect(matchLocale('pt')).toBe('pt-BR');
    expect(matchLocale('pt-PT')).toBe('pt-BR');
    expect(matchLocale('es-AR')).toBe('es');
    expect(matchLocale('en_GB')).toBe('en');
  });

  it('returns null for anything it does not speak', () => {
    expect(matchLocale('de-DE')).toBeNull();
    expect(matchLocale('')).toBeNull();
    expect(matchLocale(undefined)).toBeNull();
    expect(matchLocale(null)).toBeNull();
  });
});

// The browser side of the same module. `detectLocale()` is the only code path
// that decides what language a first-time visitor sees, and it reads three
// globals the Node test environment does not have (`window.localStorage`,
// `navigator.languages`, `document.documentElement`) — so each test installs
// its own browser and takes it down again. `navigator` is a CONFIGURABLE
// ACCESSOR on Node's globalThis, not a plain property, so it takes
// defineProperty; plain assignment silently does nothing.
describe('browser-language detection', () => {
  const I18N_PATH = require.resolve('../../../src/ui/src/i18n');
  const nativeNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const globals = globalThis as unknown as Record<string, unknown>;

  interface Browser {
    documentElement: { lang: string };
    stored: string | null;
  }

  function installBrowser(options: {
    stored?: string | null;
    storageThrows?: boolean;
    languages?: string[];
  } = {}): Browser {
    const browser: Browser = { documentElement: { lang: 'en' }, stored: options.stored ?? null };
    globals.window = {
      localStorage: {
        getItem: () => {
          if (options.storageThrows) throw new Error('storage disabled');
          return browser.stored;
        },
        setItem: (_key: string, value: string) => {
          if (options.storageThrows) throw new Error('storage disabled');
          browser.stored = value;
        },
      },
    };
    // `createElement` is not for us: re-importing the module pulls in Vue, and
    // @vue/runtime-dom probes `document.createElement('template')` at import
    // time. Without it the stub document crashes the import we are testing.
    globals.document = {
      documentElement: browser.documentElement,
      createElement: () => ({}),
    };
    Object.defineProperty(globalThis, 'navigator', {
      value: { languages: options.languages ?? [], language: undefined },
      configurable: true,
      writable: true,
    });
    return browser;
  }

  afterEach(() => {
    delete globals.window;
    delete globals.document;
    /* istanbul ignore else: every supported Node exposes a navigator global */
    if (nativeNavigator) Object.defineProperty(globalThis, 'navigator', nativeNavigator);
    jest.resetModules();
  });

  it('speaks the first browser language it knows', () => {
    installBrowser({ languages: ['de-DE', 'pt-PT', 'en-US'] });
    expect(detectLocale()).toBe('pt-BR');
  });

  it('falls back to English when it speaks none of them', () => {
    installBrowser({ languages: ['de-DE', 'ja-JP'] });
    expect(detectLocale()).toBe('en');
  });

  it('lets a stored choice win over the browser', () => {
    // The point of storing it: a pt-BR machine whose user picked English keeps
    // English, on every reload, without fighting the OS setting.
    installBrowser({ stored: 'en', languages: ['pt-BR'] });
    expect(detectLocale()).toBe('en');
  });

  it('ignores a stored value that is not a locale we ship', () => {
    installBrowser({ stored: 'klingon', languages: ['es-AR'] });
    expect(detectLocale()).toBe('es');
  });

  it('still detects when storage is disabled (private mode, embedded webview)', () => {
    installBrowser({ storageThrows: true, languages: ['es-MX'] });
    expect(detectLocale()).toBe('es');
  });

  it('puts the DETECTED locale on <html lang> at boot, not only on a manual switch', () => {
    // index.html ships lang="en". A pt-BR browser that renders a translated
    // dashboard under lang="en" is read aloud in the wrong language.
    const browser = installBrowser({ languages: ['pt-BR'] });
    jest.isolateModules(() => {
      require(I18N_PATH);
    });
    expect(browser.documentElement.lang).toBe('pt-BR');
  });

  it('keeps <html lang> and storage in step when the user switches language', () => {
    const browser = installBrowser({ languages: ['en'] });
    let mod!: typeof import('../../../src/ui/src/i18n');
    jest.isolateModules(() => {
      mod = require(I18N_PATH) as typeof import('../../../src/ui/src/i18n');
    });
    expect(browser.documentElement.lang).toBe('en');

    mod.setLocale('es');
    expect(browser.documentElement.lang).toBe('es');
    expect(browser.stored).toBe('es');
    expect(mod.useI18n().locale.value).toBe('es');
  });

  it('survives a switch when storage refuses the write', () => {
    const browser = installBrowser({ storageThrows: true, languages: ['en'] });
    let mod!: typeof import('../../../src/ui/src/i18n');
    jest.isolateModules(() => {
      mod = require(I18N_PATH) as typeof import('../../../src/ui/src/i18n');
    });
    // The choice must still apply for this session — only persistence is lost.
    expect(() => mod.setLocale('pt-BR')).not.toThrow();
    expect(browser.documentElement.lang).toBe('pt-BR');
    expect(mod.useI18n().locale.value).toBe('pt-BR');
  });
});
