import { describe, expect, test } from 'bun:test';
import { extractDocumentTitle, sanitizeDocumentFilename } from '../src/index.js';

describe('extractDocumentTitle — markdown', () => {
  test('frontmatter title wins over body heading', () => {
    const md = [
      '---',
      'title: The Frontmatter Title',
      '---',
      '',
      '# A Different H1',
      '',
      'Body.',
    ].join('\n');
    expect(extractDocumentTitle(md, 'markdown')).toBe('The Frontmatter Title');
  });

  test('falls back to first H1 when frontmatter has no title', () => {
    expect(extractDocumentTitle('# Hello World\n\nBody.\n', 'markdown')).toBe('Hello World');
  });

  test('handles frontmatter without title by scanning body', () => {
    const md = ['---', 'author: Paul', '---', '', '# Body Title'].join('\n');
    expect(extractDocumentTitle(md, 'markdown')).toBe('Body Title');
  });

  test('strips inline formatting from headings', () => {
    expect(extractDocumentTitle('# **Bold** and *italic* with `code`', 'markdown')).toBe(
      'Bold and italic with code',
    );
  });

  test('strips link syntax, keeping visible text', () => {
    expect(extractDocumentTitle('# About [Marginalia](https://x)\n', 'markdown')).toBe(
      'About Marginalia',
    );
  });

  test('trailing closing `#`s are removed', () => {
    expect(extractDocumentTitle('# Title ##\n', 'markdown')).toBe('Title');
  });

  test('quoted frontmatter titles are unquoted', () => {
    expect(
      extractDocumentTitle('---\ntitle: "Quoted: with colon"\n---\n\n# H1\n', 'markdown'),
    ).toBe('Quoted: with colon');
  });

  test('no heading or frontmatter → null', () => {
    expect(extractDocumentTitle('Just a body paragraph.\n', 'markdown')).toBeNull();
  });

  test('empty document → null', () => {
    expect(extractDocumentTitle('', 'markdown')).toBeNull();
  });

  test('ignores H2/H3 and picks the first H1', () => {
    const md = ['## Subsection first', '', '# Real title', '', '## More'].join('\n');
    expect(extractDocumentTitle(md, 'markdown')).toBe('Real title');
  });

  test('returns null when the document has no H1 (only deeper headings)', () => {
    expect(extractDocumentTitle('## Only H2s here\n\n### And H3\n', 'markdown')).toBeNull();
  });

  test('ignores `# ...` inside fenced code blocks (backticks)', () => {
    const md = [
      '```bash',
      '# This is a shell comment',
      'echo hi',
      '```',
      '',
      '# Real Title',
      '',
      'Body.',
    ].join('\n');
    expect(extractDocumentTitle(md, 'markdown')).toBe('Real Title');
  });

  test('ignores `# ...` inside fenced code blocks (tildes)', () => {
    const md = ['~~~', '# Not a heading', '~~~', '', '# The Actual Title'].join('\n');
    expect(extractDocumentTitle(md, 'markdown')).toBe('The Actual Title');
  });

  test('handles longer closing fences correctly (4 backticks)', () => {
    // CommonMark: a closing fence must be ≥ the opening fence length
    // of the same character. Use 4-backtick fence to include 3
    // backticks inside; we should still skip everything until the
    // matching close.
    const md = [
      '````',
      '```',
      '# Still inside the nested example',
      '```',
      '````',
      '',
      '# The Real Title',
    ].join('\n');
    expect(extractDocumentTitle(md, 'markdown')).toBe('The Real Title');
  });

  test('4-space-indented `# ...` is a code block, not a heading', () => {
    // CommonMark: ATX headings allow 0–3 spaces of indent; 4+ spaces
    // is an indented code block. The extractor should respect this.
    const md = ['    # Not a heading (indented code)', '', '# Actual Title'].join('\n');
    expect(extractDocumentTitle(md, 'markdown')).toBe('Actual Title');
  });

  test('document that is ONLY a code block yields no title', () => {
    const md = ['```', '# Inside only', '```', ''].join('\n');
    expect(extractDocumentTitle(md, 'markdown')).toBeNull();
  });
});

describe('extractDocumentTitle — asciidoc', () => {
  test('picks up a `= Title` header', () => {
    const adoc = '= The Doc\n\nBody here.\n';
    expect(extractDocumentTitle(adoc, 'asciidoc')).toBe('The Doc');
  });

  test('skips leading attributes and comments', () => {
    const adoc = ['// comment', ':author: Paul', '', '= After Preamble', '', 'Body.'].join('\n');
    expect(extractDocumentTitle(adoc, 'asciidoc')).toBe('After Preamble');
  });

  test('frontmatter title still wins when both are present', () => {
    const adoc = ['---', 'title: YAML Wins', '---', '', '= AsciiDoc Header'].join('\n');
    expect(extractDocumentTitle(adoc, 'asciidoc')).toBe('YAML Wins');
  });

  test('returns null when no header is found', () => {
    expect(extractDocumentTitle('Just paragraph text.\n', 'asciidoc')).toBeNull();
  });
});

describe('sanitizeDocumentFilename', () => {
  test('passes through ordinary alphanumeric titles unchanged (modulo collapsed whitespace)', () => {
    expect(sanitizeDocumentFilename('My Great Doc', 'uid-fallback')).toBe('My_Great_Doc');
  });

  test('preserves dots and hyphens (useful in filenames)', () => {
    expect(sanitizeDocumentFilename('v1.2-release-notes', 'fb')).toBe('v1.2-release-notes');
  });

  test('collapses runs of non-word characters to a single underscore', () => {
    expect(sanitizeDocumentFilename('Alpha   &&&   Beta', 'fb')).toBe('Alpha_Beta');
  });

  test('falls back to the fallback when the title is null or undefined', () => {
    expect(sanitizeDocumentFilename(null, 'abc123')).toBe('abc123');
    expect(sanitizeDocumentFilename(undefined, 'abc123')).toBe('abc123');
  });

  test('preserves the fallback verbatim when no title is available', () => {
    expect(sanitizeDocumentFilename(null, '-abc123_')).toBe('-abc123_');
    expect(sanitizeDocumentFilename('   ', '_-uid-_')).toBe('_-uid-_');
  });

  test('falls back when the title trims to empty', () => {
    expect(sanitizeDocumentFilename('   ', 'abc123')).toBe('abc123');
  });

  test('falls back when the title is emoji-only (sanitizes to bare underscores)', () => {
    // "🎉" → "_", then trim separators → "", then fallback.
    expect(sanitizeDocumentFilename('🎉', 'abc123')).toBe('abc123');
    expect(sanitizeDocumentFilename('🎉✨🎊', 'abc123')).toBe('abc123');
    expect(sanitizeDocumentFilename('🎉✨🎊', '-abc123_')).toBe('-abc123_');
  });

  test('strips leading/trailing separators so we never produce a hidden file', () => {
    expect(sanitizeDocumentFilename('...Secret Plans...', 'fb')).toBe('Secret_Plans');
    expect(sanitizeDocumentFilename('---draft---', 'fb')).toBe('draft');
  });

  test('clamps to 80 characters', () => {
    const long = 'x'.repeat(200);
    const out = sanitizeDocumentFilename(long, 'fb');
    expect(out.length).toBeLessThanOrEqual(80);
  });

  test('matches server + client — same input yields same output', () => {
    // Regression lock: server (DOCX route) and client (DownloadMenu)
    // both call this helper, so their filenames stay aligned.
    const title = 'Weekly digest: 🎉 launch';
    const a = sanitizeDocumentFilename(title, 'uid');
    const b = sanitizeDocumentFilename(title, 'uid');
    expect(a).toBe(b);
    expect(a).toBe('Weekly_digest_launch');
  });
});
