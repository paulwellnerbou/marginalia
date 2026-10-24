/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import { findDocMetaRegion, planDocMetaInsert } from './doc-meta-edit.js';

function apply(source: string, plan: { at: number; text: string }): string {
  return source.slice(0, plan.at) + plan.text + source.slice(plan.at);
}

describe('planDocMetaInsert in Markdown', () => {
  test('puts the summary under the title, cursor on the empty line', () => {
    const source = '# The Book\n\n## One\n\nText.\n';
    const plan = planDocMetaInsert(source, 'markdown', 'summary');
    const next = apply(source, plan);
    expect(next).toBe('# The Book\n\n<!-- summary -->\n\n<!-- /summary -->\n\n## One\n\nText.\n');
    expect(next.slice(plan.cursor - 17, plan.cursor + 1)).toBe('<!-- summary -->\n\n');
  });

  test('skips frontmatter, and starts at the top without a title', () => {
    const source = '---\ntitle: X\n---\nOpening line.\n';
    expect(apply(source, planDocMetaInsert(source, 'markdown', 'about'))).toBe(
      '---\ntitle: X\n---\n\n<!-- about -->\n\n<!-- /about -->\n\nOpening line.\n',
    );
  });

  test('keeps the summary before an existing about, and the about after a summary', () => {
    const withAbout = '# T\n\n<!-- about -->\nNotes.\n<!-- /about -->\n\nText.\n';
    expect(apply(withAbout, planDocMetaInsert(withAbout, 'markdown', 'summary'))).toBe(
      '# T\n\n<!-- summary -->\n\n<!-- /summary -->\n\n<!-- about -->\nNotes.\n<!-- /about -->\n\nText.\n',
    );
    const withSummary = '# T\n\n<!-- summary -->\nBlurb.\n<!-- /summary -->\nText.\n';
    expect(apply(withSummary, planDocMetaInsert(withSummary, 'markdown', 'about'))).toBe(
      '# T\n\n<!-- summary -->\nBlurb.\n<!-- /summary -->\n\n<!-- about -->\n\n<!-- /about -->\n\nText.\n',
    );
  });

  test('works on an empty document', () => {
    expect(apply('', planDocMetaInsert('', 'markdown', 'summary'))).toBe(
      '<!-- summary -->\n\n<!-- /summary -->\n',
    );
  });
});

describe('planDocMetaInsert in AsciiDoc', () => {
  test('goes after the whole document header', () => {
    const source = '= The Book\nPaul\n:toc:\n\n== One\n\nText.\n';
    expect(apply(source, planDocMetaInsert(source, 'asciidoc', 'summary'))).toBe(
      '= The Book\nPaul\n:toc:\n\n[.summary]\n--\n\n--\n\n== One\n\nText.\n',
    );
  });
});

describe('findDocMetaRegion', () => {
  test('finds the text between Markdown markers', () => {
    const source = '# T\n\n<!-- summary -->\nBlurb.\n<!-- /summary -->\n';
    const span = findDocMetaRegion(source, 'markdown', 'summary');
    expect(span && source.slice(span.innerStart, span.innerEnd)).toBe('Blurb.\n');
    expect(findDocMetaRegion(source, 'markdown', 'about')).toBeNull();
  });

  test('ignores markers inside a code fence, and an unclosed marker', () => {
    expect(
      findDocMetaRegion(
        '```\n<!-- summary -->\nx\n<!-- /summary -->\n```\n',
        'markdown',
        'summary',
      ),
    ).toBeNull();
    expect(findDocMetaRegion('<!-- summary -->\nOpen.\n', 'markdown', 'summary')).toBeNull();
  });

  test('finds an AsciiDoc open block by its role', () => {
    const source = '= T\n\n[.about]\n--\nNotes.\n--\n';
    const span = findDocMetaRegion(source, 'asciidoc', 'about');
    expect(span && source.slice(span.innerStart, span.innerEnd)).toBe('Notes.\n');
  });
});
