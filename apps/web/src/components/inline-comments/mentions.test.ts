import { describe, expect, test } from 'bun:test';
import type { Element, Root } from 'hast';
import { rehypeMentions, splitMentions } from './mentions.js';

const roster = ['og', 'Paul', 'Paul Wellner Bou'];

describe('splitMentions', () => {
  test('marks a roster name after @', () => {
    expect(splitMentions('@og Integration in des', roster)).toEqual([
      { text: '@og', name: 'og' },
      { text: ' Integration in des' },
    ]);
  });

  test('prefers the longest matching name and ignores case', () => {
    expect(splitMentions('cc @paul wellner bou, thanks', roster)).toEqual([
      { text: 'cc ' },
      { text: '@paul wellner bou', name: 'Paul Wellner Bou' },
      { text: ', thanks' },
    ]);
  });

  test('marks @all', () => {
    expect(splitMentions('@all please look', [])).toEqual([
      { text: '@all', name: 'all' },
      { text: ' please look' },
    ]);
  });

  test('leaves emails, unknown names and name prefixes alone', () => {
    expect(splitMentions('mail og@og.de', roster)).toBeNull();
    expect(splitMentions('@someone else', roster)).toBeNull();
    expect(splitMentions('@ogre', roster)).toBeNull();
    expect(splitMentions('@allison', roster)).toBeNull();
  });

  test('finds several mentions', () => {
    const segments = splitMentions('@og and @Paul.', roster);
    expect(segments?.filter((s) => s.name).map((s) => s.name)).toEqual(['og', 'Paul']);
  });
});

function paragraph(children: Element['children']): Root {
  return {
    type: 'root',
    children: [{ type: 'element', tagName: 'p', properties: {}, children }],
  };
}

describe('rehypeMentions', () => {
  test('wraps mentions and flags the viewer', () => {
    const tree = paragraph([{ type: 'text', value: '@og and @Paul' }]);
    rehypeMentions({ names: roster, self: 'paul' })()(tree);
    const p = tree.children[0] as Element;
    const spans = p.children.filter((c): c is Element => c.type === 'element');
    expect(spans.map((s) => s.properties.className)).toEqual([
      ['ic-mention'],
      ['ic-mention', 'ic-mention-self'],
    ]);
  });

  test('leaves code and links verbatim', () => {
    const tree = paragraph([
      {
        type: 'element',
        tagName: 'code',
        properties: {},
        children: [{ type: 'text', value: '@og' }],
      },
      { type: 'element', tagName: 'a', properties: {}, children: [{ type: 'text', value: '@og' }] },
    ]);
    rehypeMentions({ names: roster, self: null })()(tree);
    const p = tree.children[0] as Element;
    for (const child of p.children as Element[]) expect(child.children[0]?.type).toBe('text');
  });
});
