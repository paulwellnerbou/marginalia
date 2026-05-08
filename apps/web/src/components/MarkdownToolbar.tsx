import {
  CodeIcon,
  FontBoldIcon,
  FontItalicIcon,
  Link2Icon,
  ListBulletIcon,
  QuoteIcon,
  StrikethroughIcon,
} from '@radix-ui/react-icons';
import { IconButton } from '@radix-ui/themes';
import type { EditorView } from 'codemirror';
import { Heading1, Heading2, Heading3, ListOrdered, WrapText } from 'lucide-react';
import type { RefObject } from 'react';

// ── shared helpers ────────────────────────────────────────────────────────────

function wrapSelection(view: EditorView, before: string, after: string) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const outerBefore = view.state.sliceDoc(Math.max(0, from - before.length), from);
  const outerAfter = view.state.sliceDoc(to, Math.min(view.state.doc.length, to + after.length));
  if (outerBefore === before && outerAfter === after) {
    view.dispatch({
      changes: [
        { from: from - before.length, to: from, insert: '' },
        { from: to, to: to + after.length, insert: '' },
      ],
      selection: { anchor: from - before.length, head: to - before.length },
    });
  } else {
    view.dispatch({
      changes: { from, to, insert: before + selected + after },
      selection: { anchor: from + before.length, head: from + before.length + selected.length },
    });
  }
  view.focus();
}

function setHeadingWithPattern(view: EditorView, prefix: string, existingRe: RegExp) {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const existingMatch = line.text.match(existingRe);
  const existingPrefix = existingMatch?.[1];
  if (existingPrefix !== undefined) {
    if (line.text.startsWith(prefix)) {
      view.dispatch({ changes: { from: line.from, to: line.from + prefix.length, insert: '' } });
    } else {
      view.dispatch({
        changes: { from: line.from, to: line.from + existingPrefix.length, insert: prefix },
      });
    }
  } else {
    view.dispatch({ changes: { from: line.from, to: line.from, insert: prefix } });
  }
  view.focus();
}

function toggleLinePrefix(view: EditorView, prefix: string) {
  const { from, to } = view.state.selection.main;
  const firstLine = view.state.doc.lineAt(from);
  const lastLine = view.state.doc.lineAt(to);
  const lines = [];
  for (let n = firstLine.number; n <= lastLine.number; n++) lines.push(view.state.doc.line(n));
  const allHave = lines.every((l) => l.text.startsWith(prefix));
  view.dispatch({
    changes: lines.flatMap((l) => {
      if (allHave) return [{ from: l.from, to: l.from + prefix.length, insert: '' }];
      if (!l.text.startsWith(prefix)) return [{ from: l.from, to: l.from, insert: prefix }];
      return [];
    }),
  });
  view.focus();
}

// ── markdown-specific ─────────────────────────────────────────────────────────

function mdHeading(view: EditorView, level: number) {
  setHeadingWithPattern(view, '#'.repeat(level) + ' ', /^(#{1,6} )/);
}

function mdLink(view: EditorView) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  view.dispatch({
    changes: { from, to, insert: `[${selected}]()` },
    selection: { anchor: from + 1 + selected.length + 2 },
  });
  view.focus();
}

// ── asciidoc-specific ─────────────────────────────────────────────────────────
// Heading levels: H1 = "== ", H2 = "=== ", H3 = "==== "

function adocHeading(view: EditorView, level: number) {
  setHeadingWithPattern(view, '='.repeat(level + 1) + ' ', /^(={1,6} )/);
}

function adocLink(view: EditorView) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  // Result: link:URL[text] — cursor placed inside the URL
  view.dispatch({
    changes: { from, to, insert: `link:[${selected}]` },
    selection: { anchor: from + 'link:'.length },
  });
  view.focus();
}

// ── component ─────────────────────────────────────────────────────────────────

interface Props {
  viewRef: RefObject<EditorView | null>;
  format: 'markdown' | 'asciidoc';
  wordWrap: boolean;
  onWordWrapToggle: () => void;
}

export function MarkdownToolbar({ viewRef, format, wordWrap, onWordWrapToggle }: Props) {
  function act(fn: (v: EditorView) => void) {
    return () => {
      const v = viewRef.current;
      if (v) fn(v);
    };
  }

  const isAdoc = format === 'asciidoc';

  return (
    <div
      className="markdown-toolbar"
      role="toolbar"
      aria-label="Editor formatting"
      onMouseDown={(e) => e.preventDefault()}
    >
      {/* Inline formatting */}
      <div className="markdown-toolbar__group">
        {isAdoc ? (
          <>
            <Btn
              label="Bold"
              icon={<FontBoldIcon />}
              onClick={act((v) => wrapSelection(v, '*', '*'))}
            />
            <Btn
              label="Italic"
              icon={<FontItalicIcon />}
              onClick={act((v) => wrapSelection(v, '_', '_'))}
            />
            <Btn
              label="Inline code"
              icon={<CodeIcon />}
              onClick={act((v) => wrapSelection(v, '`', '`'))}
            />
          </>
        ) : (
          <>
            <Btn
              label="Bold"
              icon={<FontBoldIcon />}
              onClick={act((v) => wrapSelection(v, '**', '**'))}
            />
            <Btn
              label="Italic"
              icon={<FontItalicIcon />}
              onClick={act((v) => wrapSelection(v, '*', '*'))}
            />
            <Btn
              label="Strikethrough"
              icon={<StrikethroughIcon />}
              onClick={act((v) => wrapSelection(v, '~~', '~~'))}
            />
            <Btn
              label="Inline code"
              icon={<CodeIcon />}
              onClick={act((v) => wrapSelection(v, '`', '`'))}
            />
          </>
        )}
      </div>

      <Sep />

      {/* Headings */}
      <div className="markdown-toolbar__group">
        <Btn
          label="Heading 1"
          icon={<Heading1 size={14} />}
          onClick={act((v) => (isAdoc ? adocHeading(v, 1) : mdHeading(v, 1)))}
        />
        <Btn
          label="Heading 2"
          icon={<Heading2 size={14} />}
          onClick={act((v) => (isAdoc ? adocHeading(v, 2) : mdHeading(v, 2)))}
        />
        <Btn
          label="Heading 3"
          icon={<Heading3 size={14} />}
          onClick={act((v) => (isAdoc ? adocHeading(v, 3) : mdHeading(v, 3)))}
        />
      </div>

      <Sep />

      {/* Block structure */}
      <div className="markdown-toolbar__group">
        {!isAdoc && (
          <Btn
            label="Blockquote"
            icon={<QuoteIcon />}
            onClick={act((v) => toggleLinePrefix(v, '> '))}
          />
        )}
        <Btn
          label="Bullet list"
          icon={<ListBulletIcon />}
          onClick={act((v) => toggleLinePrefix(v, isAdoc ? '* ' : '- '))}
        />
        <Btn
          label="Ordered list"
          icon={<ListOrdered size={14} />}
          onClick={act((v) => toggleLinePrefix(v, isAdoc ? '. ' : '1. '))}
        />
      </div>

      <Sep />

      {/* Link */}
      <div className="markdown-toolbar__group">
        <Btn
          label="Link"
          icon={<Link2Icon />}
          onClick={act((v) => (isAdoc ? adocLink(v) : mdLink(v)))}
        />
      </div>

      <div className="markdown-toolbar__spacer" />

      <IconButton
        variant={wordWrap ? 'solid' : 'ghost'}
        color="gray"
        size="1"
        onClick={onWordWrapToggle}
        title="Toggle word wrap"
        aria-label="Toggle word wrap"
        aria-pressed={wordWrap}
      >
        <WrapText size={14} />
      </IconButton>
    </div>
  );
}

function Btn({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <IconButton
      variant="ghost"
      color="gray"
      size="1"
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {icon}
    </IconButton>
  );
}

function Sep() {
  return <div className="markdown-toolbar__sep" aria-hidden />;
}
