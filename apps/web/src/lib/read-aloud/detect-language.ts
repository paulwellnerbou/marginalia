/**
 * Guess the language a document is written in, from its text.
 *
 * Nothing in the page says what language a document is in: the app's
 * `<html lang>` is the UI's, and the browser's language is the reader's.
 * A German text opened on an English iPhone would otherwise be read by
 * an English voice. No detection API ships in WebKit, so this is the
 * classic cheap approach — the writing system first, then, for scripts
 * shared by many languages, counts of each language's most frequent
 * function words. It only has to beat the reader's system language, and
 * the language picker is there when it doesn't.
 *
 * Covers the languages Apple and Google ship speech voices for.
 */

/** Scripts that name their language outright. Han is resolved below. */
const SCRIPT_LANGUAGES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\p{Script=Hangul}/u, 'ko'],
  [/\p{Script=Greek}/u, 'el'],
  [/\p{Script=Hebrew}/u, 'he'],
  [/\p{Script=Arabic}/u, 'ar'],
  [/\p{Script=Thai}/u, 'th'],
  [/\p{Script=Devanagari}/u, 'hi'],
  [/\p{Script=Bengali}/u, 'bn'],
  [/\p{Script=Tamil}/u, 'ta'],
  [/\p{Script=Telugu}/u, 'te'],
  [/\p{Script=Kannada}/u, 'kn'],
];

const LATIN_STOPWORDS: Record<string, string> = {
  en: 'the and of to is that it with for as was this are be have not you but which they from by at or his her will would can there their what been has were an we if all more when about into',
  de: 'der die das und ist nicht ein eine einen dem den des mit sich auch auf für von zu es im sie ich wir werden wird sind oder aber wenn noch nach bei wie kann dass nur war hat haben über soll diese',
  fr: 'le la les et des du un une est que qui dans pour pas sur au aux avec ce cette il elle sont ne se plus par mais ou nous vous leur été être fait comme tout aussi',
  es: 'el la los las y de que en un una es por con no para se del al lo como más pero sus su está son fue muy también cuando ya porque esta este hay entre sobre ser tiene',
  it: 'il la le di che e è un una per non con sono del della delle dei gli nel nella si anche come più ma questo questa alla ha essere stato suo sua loro quando perché dove molto',
  pt: 'o a os as de que e do da dos das em um uma é não para com por se na no mais mas ao como foi são está também ser pela pelo isso este esta muito quando já tem',
  ca: 'el la els les i de que en un una és per amb no del al es com més però seu seva està són va molt també quan ja perquè aquesta aquest hi entre sobre ser té',
  nl: 'de het een en van is dat niet zijn op te met voor die er maar ook als bij aan om dit wordt naar nog uit worden kan hij ze zij wij geen deze heeft was door of wel',
  sv: 'och att det som en är på av för med den till inte har om ett jag de var men hon han så vi kan också eller från när efter sig hade skulle detta vara blir mycket',
  da: 'og at det er en til på af for med den ikke som har de et jeg var men han hun så vi kan også eller fra når efter sig havde skulle dette være bliver meget hvor hvad nogle',
  nb: 'og å det er en til på av for med den ikke som har de et jeg var men han hun så vi kan også eller fra når etter seg hadde skulle dette være blir mye hvor hva noen',
  fi: 'ja on ei se että oli hän kun mutta tai ovat olla joka myös sen kuin niin jos mitä vain tämä siitä nyt sitten jo voi ole hänen minä me',
  pl: 'i w na z nie się to jest że do o jak ale po co tak za od są jego przez już dla czy był być może jej tylko oraz gdy który która które',
  cs: 'a v se na je že to s z do o jak ale po co tak za od jsou jeho pro už byl být může její jen nebo když který která které také podle jako bylo není tento',
  sk: 'a v sa na je že to s z do o ako ale po čo tak za od sú jeho pre už bol byť môže jej len alebo keď ktorý ktorá ktoré tiež podľa bolo nie tento',
  hr: 'i u je na se da za su od s kao ali što to a o iz koji koja koje bi ili sam biti bio samo kad još može prema nije već ima',
  sl: 'in je v na se da za so od s kot ali kar to a o iz ki bi ter sem biti bil samo ko še lahko po tudi ni že ima',
  hu: 'a az és hogy nem is egy van meg de ez csak már mint még ha volt vagy el azt kell pedig lesz úgy nagyon sem amely ami mert',
  ro: 'și în de la a cu că nu pe este o un care mai din pentru se sunt lui au ce ca fost sau dar prin această acest fi doar',
  tr: 've bir bu da de için ile çok ne gibi daha ama olarak var en o olan kadar sonra değil her mi şey ben sen biz onun veya ancak göre',
  id: 'yang dan di ini itu dengan untuk tidak dari dalam akan pada juga ke karena ada oleh saya kita mereka bisa sudah atau seperti adalah tersebut lebih harus namun',
  ms: 'yang dan di ini itu dengan untuk tidak dari dalam akan pada juga ke kerana ada oleh saya kita mereka boleh sudah atau seperti adalah tersebut lebih mesti tetapi',
  vi: 'và của là có các không được một cho trong những người với này đã để khi cũng như đến về ra từ thì nhưng sẽ nhiều làm',
};

const CYRILLIC_STOPWORDS: Record<string, string> = {
  ru: 'и в не на что с как это по но из у к за от то так же для был его она он они мы вы уже или только её если бы когда ещё быть',
  uk: 'і в не на що з як це по але із у до за від та так же для був його вона він вони ми ви вже або тільки її якщо би коли ще бути',
  bg: 'и в не на че с като това по но от за да се е са той тя те ние вие вече или само ако би когато още бъде този тази беше има',
};

type WordWeights = Map<string, Map<string, number>>;

/**
 * Word → language → weight. A word several languages share counts for
 * each of them in proportion, so "de" or "la" barely moves the needle
 * and the words only one language uses decide.
 */
function buildWeights(lists: Record<string, string>): WordWeights {
  const owners = new Map<string, string[]>();
  for (const [lang, words] of Object.entries(lists)) {
    for (const word of new Set(words.split(' '))) {
      const list = owners.get(word) ?? [];
      list.push(lang);
      owners.set(word, list);
    }
  }
  const weights: WordWeights = new Map();
  for (const [word, langs] of owners) {
    weights.set(word, new Map(langs.map((lang) => [lang, 1 / langs.length])));
  }
  return weights;
}

let latinWeights: WordWeights | null = null;
let cyrillicWeights: WordWeights | null = null;

/**
 * A Chinese, Japanese or Korean character carries about as much as a
 * short word in an alphabet. Counted one-for-one, the English product
 * names in a Japanese technical text would outvote the Japanese.
 */
const DENSE_SCRIPT_WEIGHT = 3;
const DENSE_SCRIPTS = new Set(['ja', 'zh', 'ko']);

/** Below this many weighted hits the text is too short to call. */
const MIN_SCORE = 2;
/** The winner must clear the runner-up by this factor. */
const MIN_LEAD = 1.2;

/** Enough text to be sure; more only costs time on book-length documents. */
const MAX_SAMPLE_CHARS = 20_000;

/** Primary language subtag of `text`, or null when it can't be told. */
export function detectLanguage(text: string): string | null {
  const sample = text
    .slice(0, MAX_SAMPLE_CHARS)
    .normalize('NFC')
    .toLowerCase()
    // Turkish İ lowercases to i plus a combining dot, which would keep
    // "İçin" from ever matching "için".
    .replace(/i\u0307/g, 'i');

  const script = dominantScript(sample);
  if (!script) return null;
  if (script === 'latin') {
    latinWeights ??= buildWeights(LATIN_STOPWORDS);
    return scoreWords(sample, latinWeights);
  }
  if (script === 'cyrillic') {
    cyrillicWeights ??= buildWeights(CYRILLIC_STOPWORDS);
    return scoreWords(sample, cyrillicWeights);
  }
  return script;
}

/**
 * `latin`, `cyrillic`, `ja`, `zh`, or a language from SCRIPT_LANGUAGES —
 * whichever writing system most letters belong to.
 */
function dominantScript(sample: string): string | null {
  const counts = new Map<string, number>();
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  let kana = 0;

  for (const char of sample) {
    if (!/\p{L}/u.test(char)) continue;
    if (/\p{Script=Latin}/u.test(char)) bump('latin');
    else if (/\p{Script=Cyrillic}/u.test(char)) bump('cyrillic');
    else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char)) {
      kana++;
      bump('ja');
    } else if (/\p{Script=Han}/u.test(char)) bump('han');
    else {
      const match = SCRIPT_LANGUAGES.find(([pattern]) => pattern.test(char));
      if (match) bump(match[1]);
    }
  }

  // Japanese mixes kanji into kana; Chinese has no kana at all. A real
  // share of kana makes the Han characters Japanese.
  const han = counts.get('han') ?? 0;
  if (han > 0) {
    counts.delete('han');
    const key = kana > 0 && kana * 10 >= han ? 'ja' : 'zh';
    counts.set(key, (counts.get(key) ?? 0) + han);
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [key, raw] of counts) {
    const count = DENSE_SCRIPTS.has(key) ? raw * DENSE_SCRIPT_WEIGHT : raw;
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

function scoreWords(sample: string, weights: WordWeights): string | null {
  const scores = new Map<string, number>();
  for (const [word] of sample.matchAll(/\p{L}[\p{L}\p{M}]*/gu)) {
    const langs = weights.get(word);
    if (!langs) continue;
    for (const [lang, weight] of langs) scores.set(lang, (scores.get(lang) ?? 0) + weight);
  }

  const ranked = [...scores].sort((a, b) => b[1] - a[1]);
  const [first, second] = ranked;
  if (!first || first[1] < MIN_SCORE) return null;
  if (second && first[1] < second[1] * MIN_LEAD) return null;
  return first[0];
}
