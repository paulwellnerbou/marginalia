/**
 * Curated shortcode → emoji map for `:foo`-style inline autocomplete in
 * the comment composer. Names follow the GitHub/Slack convention so the
 * common shortcodes a user already has muscle memory for "just work".
 *
 * Intentionally NOT exhaustive — the ~100 entries here cover the bulk of
 * day-to-day reactions. Users wanting a less-common emoji should fall
 * back to the full reaction picker (which fetches the complete dataset
 * from emojibase). Keeping this map small means:
 *
 *   - zero network on every page load (vs. ~200KB of emojibase data)
 *   - O(N) filtering stays trivial
 *   - the autocomplete menu doesn't drown the user in 3000 obscure
 *     options every time they type a colon
 */
export const EMOJI_SHORTCODES: Readonly<Record<string, string>> = {
  // Faces — positive
  smile: '😄',
  smiley: '😀',
  grin: '😁',
  laughing: '😆',
  joy: '😂',
  rofl: '🤣',
  blush: '😊',
  innocent: '😇',
  wink: '😉',
  yum: '😋',
  sunglasses: '😎',
  heart_eyes: '😍',
  star_struck: '🤩',
  kissing_heart: '😘',
  hugs: '🤗',
  thinking: '🤔',
  zipper_mouth: '🤐',
  raised_eyebrow: '🤨',
  neutral_face: '😐',
  expressionless: '😑',
  no_mouth: '😶',
  smirk: '😏',
  unamused: '😒',
  rolling_eyes: '🙄',
  grimacing: '😬',
  lying_face: '🤥',

  // Faces — negative / loud
  sob: '😭',
  cry: '😢',
  worried: '😟',
  frowning: '😦',
  anguished: '😧',
  fearful: '😨',
  cold_sweat: '😰',
  scream: '😱',
  tired_face: '😫',
  weary: '😩',
  triumph: '😤',
  angry: '😠',
  rage: '😡',
  cursing_face: '🤬',
  exploding_head: '🤯',
  flushed: '😳',
  hot_face: '🥵',
  cold_face: '🥶',
  woozy: '🥴',
  nauseated: '🤢',
  vomiting: '🤮',
  sneezing: '🤧',
  mask: '😷',
  thermometer_face: '🤒',
  bandaged_head: '🤕',

  // Hands & gestures
  '+1': '👍',
  thumbsup: '👍',
  '-1': '👎',
  thumbsdown: '👎',
  ok_hand: '👌',
  pinched_fingers: '🤌',
  fingers_crossed: '🤞',
  v: '✌️',
  metal: '🤘',
  call_me: '🤙',
  point_up: '☝️',
  point_down: '👇',
  point_left: '👈',
  point_right: '👉',
  raised_hand: '✋',
  wave: '👋',
  clap: '👏',
  raised_hands: '🙌',
  open_hands: '👐',
  pray: '🙏',
  handshake: '🤝',
  muscle: '💪',
  facepalm: '🤦',
  shrug: '🤷',
  salute: '🫡',

  // Hearts & symbols
  heart: '❤️',
  orange_heart: '🧡',
  yellow_heart: '💛',
  green_heart: '💚',
  blue_heart: '💙',
  purple_heart: '💜',
  black_heart: '🖤',
  white_heart: '🤍',
  broken_heart: '💔',
  two_hearts: '💕',
  sparkling_heart: '💖',
  fire: '🔥',
  sparkles: '✨',
  star: '⭐',
  star2: '🌟',
  boom: '💥',
  zap: '⚡',
  '100': '💯',
  bulb: '💡',
  warning: '⚠️',
  no_entry: '⛔',
  white_check_mark: '✅',
  heavy_check_mark: '✔️',
  x: '❌',
  question: '❓',
  exclamation: '❗',

  // Objects & activity
  rocket: '🚀',
  tada: '🎉',
  confetti_ball: '🎊',
  trophy: '🏆',
  medal: '🏅',
  dart: '🎯',
  eyes: '👀',
  brain: '🧠',
  bug: '🐛',
  hammer: '🔨',
  wrench: '🔧',
  gear: '⚙️',
  lock: '🔒',
  unlock: '🔓',
  key: '🔑',
  pencil: '✏️',
  memo: '📝',
  package: '📦',
  envelope: '✉️',
  mailbox: '📬',
  hourglass: '⏳',
  clock: '🕐',
  calendar: '📅',
  chart_up: '📈',
  chart_down: '📉',
  bar_chart: '📊',
  computer: '💻',
  phone: '📱',
  bell: '🔔',
  no_bell: '🔕',
  speech_balloon: '💬',
  thought_balloon: '💭',
  zzz: '💤',

  // Animals & nature
  dog: '🐶',
  cat: '🐱',
  mouse: '🐭',
  rabbit: '🐰',
  bear: '🐻',
  panda: '🐼',
  fox: '🦊',
  unicorn: '🦄',
  whale: '🐳',
  octopus: '🐙',
  butterfly: '🦋',
  bee: '🐝',
  ant: '🐜',
  snail: '🐌',
  crab: '🦀',
  poop: '💩',
  ghost: '👻',
  alien: '👽',
  robot: '🤖',
  skull: '💀',

  // Food & drink
  pizza: '🍕',
  hamburger: '🍔',
  fries: '🍟',
  taco: '🌮',
  burrito: '🌯',
  hotdog: '🌭',
  bread: '🍞',
  cheese: '🧀',
  egg: '🥚',
  apple: '🍎',
  banana: '🍌',
  cherries: '🍒',
  grapes: '🍇',
  lemon: '🍋',
  strawberry: '🍓',
  watermelon: '🍉',
  pineapple: '🍍',
  cake: '🍰',
  birthday: '🎂',
  cookie: '🍪',
  donut: '🍩',
  chocolate_bar: '🍫',
  popcorn: '🍿',
  beer: '🍺',
  beers: '🍻',
  wine_glass: '🍷',
  cocktail: '🍸',
  champagne: '🍾',
  coffee: '☕',
  tea: '🍵',

  // Weather & sky
  sun: '☀️',
  cloud: '☁️',
  rainbow: '🌈',
  umbrella: '☂️',
  snowflake: '❄️',
  snowman: '⛄',
  moon: '🌙',
  earth: '🌍',
};

export interface ActiveShortcode {
  /** Index of the leading `:` in the source string. */
  start: number;
  /** Index just past the query — typically the current caret position. */
  end: number;
  /** Lowercased query (chars after `:`, without the colon itself). */
  query: string;
}

/**
 * Detect whether the caret is currently inside a `:shortcode` token.
 *
 * Returns null when:
 *   - there is no preceding `:` on the current line
 *   - the `:` is not at a word boundary (e.g. inside a URL, time, ratio)
 *   - the query contains anything that isn't a valid shortcode char
 *
 * The query is intentionally case-insensitive — `:THUMB` and `:thumb`
 * resolve to the same emoji.
 */
export function getActiveShortcode(value: string, caret: number): ActiveShortcode | null {
  if (caret < 0) return null;
  const uptoCaret = value.slice(0, caret);
  const colon = uptoCaret.lastIndexOf(':');
  if (colon < 0) return null;
  // Only word-boundary `:` opens an autocomplete. We reject when the
  // preceding char is alphanumeric/underscore — same gate as the
  // @mention detection — so URLs (`https://`), times (`12:30`), and
  // ratios (`1:1`) don't fire while still allowing colons after
  // punctuation or brackets like `(:thumb` or `":thumb`.
  const prev = colon === 0 ? '' : (uptoCaret[colon - 1] ?? '');
  if (/[0-9A-Za-z_]/.test(prev)) return null;
  const query = uptoCaret.slice(colon + 1);
  if (query.length === 0) return null;
  // Bail on anything that can't appear in a shortcode key. Shortcodes
  // are `[a-z0-9_+-]`; uppercase is folded to lowercase for matching.
  if (!/^[A-Za-z0-9_+\-]+$/.test(query)) return null;
  return { start: colon, end: caret, query: query.toLowerCase() };
}

export interface ShortcodeMatch {
  shortcode: string;
  emoji: string;
}

/**
 * Filter the shortcode map by `query`, ranking prefix matches above
 * substring matches. Returns at most `limit` results — keep this small
 * (≤8) so the autocomplete menu fits below the textarea without
 * dominating the screen.
 */
export function filterShortcodes(query: string, limit: number): ShortcodeMatch[] {
  const q = query.toLowerCase();
  let exact: ShortcodeMatch | null = null;
  const prefix: ShortcodeMatch[] = [];
  const substring: ShortcodeMatch[] = [];
  // Scan the full map (~120 entries — trivially cheap) before slicing so
  // the result is order-independent. An earlier short-circuit on
  // `prefix.length >= limit` made `:s` miss `:star` because earlier
  // prefix matches filled the bucket first.
  for (const [shortcode, emoji] of Object.entries(EMOJI_SHORTCODES)) {
    if (shortcode === q) {
      exact = { shortcode, emoji };
    } else if (shortcode.startsWith(q)) {
      prefix.push({ shortcode, emoji });
    } else if (shortcode.includes(q)) {
      substring.push({ shortcode, emoji });
    }
  }
  const ranked: ShortcodeMatch[] = exact ? [exact, ...prefix, ...substring] : [...prefix, ...substring];
  return ranked.slice(0, limit);
}
