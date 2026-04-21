import { describe, expect, test } from 'bun:test';
import { extractDocumentTitle } from '../src/index.js';

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
    expect(extractDocumentTitle('# Hello World\n\nBody.\n', 'markdown')).toBe(
      'Hello World',
    );
  });

  test('handles frontmatter without title by scanning body', () => {
    const md = [
      '---',
      'author: Paul',
      '---',
      '',
      '# Body Title',
    ].join('\n');
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
      extractDocumentTitle(
        '---\ntitle: "Quoted: with colon"\n---\n\n# H1\n',
        'markdown',
      ),
    ).toBe('Quoted: with colon');
  });

  test('no heading or frontmatter → null', () => {
    expect(extractDocumentTitle('Just a body paragraph.\n', 'markdown')).toBeNull();
  });

  test('empty document → null', () => {
    expect(extractDocumentTitle('', 'markdown')).toBeNull();
  });

  test('ignores H2/H3 and picks the first H1', () => {
    const md = [
      '## Subsection first',
      '',
      '# Real title',
      '',
      '## More',
    ].join('\n');
    expect(extractDocumentTitle(md, 'markdown')).toBe('Real title');
  });

  test('returns null when the document has no H1 (only deeper headings)', () => {
    expect(extractDocumentTitle('## Only H2s here\n\n### And H3\n', 'markdown')).toBeNull();
  });
});

describe('extractDocumentTitle — asciidoc', () => {
  test('picks up a `= Title` header', () => {
    const adoc = '= The Doc\n\nBody here.\n';
    expect(extractDocumentTitle(adoc, 'asciidoc')).toBe('The Doc');
  });

  test('skips leading attributes and comments', () => {
    const adoc = [
      '// comment',
      ':author: Paul',
      '',
      '= After Preamble',
      '',
      'Body.',
    ].join('\n');
    expect(extractDocumentTitle(adoc, 'asciidoc')).toBe('After Preamble');
  });

  test('frontmatter title still wins when both are present', () => {
    const adoc = [
      '---',
      'title: YAML Wins',
      '---',
      '',
      '= AsciiDoc Header',
    ].join('\n');
    expect(extractDocumentTitle(adoc, 'asciidoc')).toBe('YAML Wins');
  });

  test('returns null when no header is found', () => {
    expect(extractDocumentTitle('Just paragraph text.\n', 'asciidoc')).toBeNull();
  });
});
