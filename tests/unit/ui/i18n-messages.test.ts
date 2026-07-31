// The dashboard's message catalogues. The UI itself is exercised by vue-tsc
// and by hand, but ONE property has to hold mechanically: every key exists in
// every language. A key added to `en` alone renders as English inside an
// otherwise translated screen — the kind of gap nobody notices until a user
// who does not read English hits it.
//
// Importing the catalogues here is safe: `messages/index.ts` pulls only the
// per-area files, and its `Locale` import is type-only, so no Vue runtime is
// dragged into the Node test environment.
import { MESSAGES } from '../../../src/ui/src/i18n/messages';
import { LOCALES, DEFAULT_LOCALE, matchLocale } from '../../../src/ui/src/i18n';

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
