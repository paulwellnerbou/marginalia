import type { Element, ElementContent, Root } from 'hast';
import { createContext } from 'react';

/** Who a comment body can mention, and who is reading it. */
export interface MentionRoster {
  names: string[];
  /** The viewer's display name, so mentions of them stand out. */
  self: string | null;
}

export const MentionRosterContext = createContext<MentionRoster>({ names: [], self: null });

export interface MentionSegment {
  text: string;
  /** Roster name (or `all`) the `@` token names; absent for plain text. */
  name?: string;
}

/**
 * Split `text` around the `@name` tokens that name someone on the
 * roster, by the server's rules (apps/server/src/mentions.ts) so the
 * highlight matches who actually got notified: the `@` must not follow
 * a word character, the longest matching name wins, and the name must
 * end at a non-word character. Returns null when nothing matches.
 */
export function splitMentions(text: string, names: readonly string[]): MentionSegment[] | null {
  if (!text.includes('@')) return null;
  const candidates = [...new Set(['all', ...names.map((n) => n.trim()).filter(Boolean)])].sort(
    (a, b) => b.length - a.length,
  );
  let segments: MentionSegment[] | null = null;
  let cut = 0;
  for (let i = text.indexOf('@'); i !== -1; i = text.indexOf('@', i + 1)) {
    if (i < cut || isWordLike(text[i - 1] ?? '')) continue;
    const rest = text.slice(i + 1);
    const name = candidates.find((c) => startsWithName(rest, c));
    if (!name) continue;
    segments ??= [];
    if (i > cut) segments.push({ text: text.slice(cut, i) });
    const end = i + 1 + name.length;
    segments.push({ text: text.slice(i, end), name });
    cut = end;
  }
  if (!segments) return null;
  if (cut < text.length) segments.push({ text: text.slice(cut) });
  return segments;
}

function startsWithName(input: string, name: string): boolean {
  if (input.slice(0, name.length).toLowerCase() !== name.toLowerCase()) return false;
  return !isWordLike(input[name.length] ?? '');
}

function isWordLike(ch: string): boolean {
  return /[0-9A-Za-z_]/.test(ch);
}

export function rehypeMentions(roster: MentionRoster) {
  const self = roster.self?.trim().toLowerCase() || null;
  return () => (tree: Root) => {
    for (const child of tree.children) {
      if (child.type === 'element') markElement(child, roster.names, self);
    }
  };
}

function markElement(el: Element, names: readonly string[], self: string | null): void {
  // Code stays verbatim; a link's text is the link's.
  if (el.tagName === 'pre' || el.tagName === 'code' || el.tagName === 'a') return;
  const next: ElementContent[] = [];
  let changed = false;
  for (const child of el.children) {
    if (child.type === 'element') markElement(child, names, self);
    const segments = child.type === 'text' ? splitMentions(child.value, names) : null;
    if (!segments) {
      next.push(child);
      continue;
    }
    changed = true;
    for (const segment of segments) {
      next.push(
        segment.name
          ? mentionSpan(segment.text, segment.name, self)
          : { type: 'text', value: segment.text },
      );
    }
  }
  if (changed) el.children = next;
}

function mentionSpan(text: string, name: string, self: string | null): Element {
  const key = name.toLowerCase();
  const isSelf = key === 'all' || (self !== null && key === self);
  return {
    type: 'element',
    tagName: 'span',
    properties: { className: isSelf ? ['ic-mention', 'ic-mention-self'] : ['ic-mention'] },
    children: [{ type: 'text', value: text }],
  };
}
