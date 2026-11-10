/// <reference types="bun" />

import { expect, test } from 'bun:test';
import type { DocumentFolder, FolderDocument } from './api.js';
import { folderLinkTarget, isFolderLink, resolveFolderLinks } from './folder-links.js';

function doc(uid: string, name: string | null, title: string | null, main = false): FolderDocument {
  return { uid, name, title, format: 'markdown', main, created_at: 0, updated_at: 0 };
}

const folder: DocumentFolder = {
  main_uid: 'story',
  documents: [
    doc('story', null, 'The Long Night', true),
    doc('outline', 'OUTLINE', 'OUTLINE'),
    doc('notes', 'My Notes', 'My Notes'),
    doc('bg', 'Background', 'Background'),
  ],
};

const uidOf = (href: string) => folderLinkTarget(href, folder)?.uid ?? null;

test('a bare name finds the document of that name', () => {
  expect(uidOf('OUTLINE')).toBe('outline');
  expect(uidOf('outline')).toBe('outline');
});

test('spaces, case and punctuation are folded', () => {
  expect(uidOf('My%20Notes')).toBe('notes');
  expect(uidOf('my-notes')).toBe('notes');
  expect(uidOf('my_notes')).toBe('notes');
});

test('a file extension and a leading ./ are ignored', () => {
  expect(uidOf('OUTLINE.md')).toBe('outline');
  expect(uidOf('./outline.adoc')).toBe('outline');
  // What Asciidoctor makes of `xref:OUTLINE.adoc[]`.
  expect(uidOf('OUTLINE.html')).toBe('outline');
});

test('the main document is found by its title when it has no name', () => {
  expect(uidOf('the-long-night')).toBe('story');
});

test('a name wins over another document whose title matches', () => {
  const clash: DocumentFolder = {
    main_uid: 'a',
    documents: [doc('a', null, 'Background', true), doc('b', 'Background', 'Background')],
  };
  expect(folderLinkTarget('Background', clash)?.uid).toBe('b');
});

test('a fragment is carried along', () => {
  expect(folderLinkTarget('OUTLINE#act-two', folder)).toEqual({ uid: 'outline', hash: '#act-two' });
  expect(folderLinkTarget('OUTLINE#', folder)).toEqual({ uid: 'outline', hash: '' });
});

test('anything but a bare name is left alone', () => {
  for (const href of [
    '',
    '#outline',
    '/d/outline',
    '?x=1',
    'https://example.com/OUTLINE',
    'mailto:OUTLINE',
    '../OUTLINE',
    'docs/OUTLINE',
    'OUTLINE?raw',
  ]) {
    expect(uidOf(href)).toBeNull();
  }
});

test('a name no document has resolves to nothing', () => {
  expect(uidOf('Appendix')).toBeNull();
  expect(uidOf('---')).toBeNull();
});

test('malformed escapes do not throw', () => {
  expect(uidOf('OUT%E0LINE')).toBeNull();
});

/** Just enough of an anchor and its root for `resolveFolderLinks`. */
function fakeLinks(hrefs: string[]) {
  const links = hrefs.map((href) => {
    const attrs = new Map<string, string>([['href', href]]);
    return {
      getAttribute: (k: string) => attrs.get(k) ?? null,
      setAttribute: (k: string, v: string) => void attrs.set(k, v),
    };
  });
  const root = { querySelectorAll: () => links } as unknown as ParentNode;
  const anchors = links as unknown as HTMLAnchorElement[];
  return { root, anchors, hrefs: () => anchors.map((a) => a.getAttribute('href')) };
}

test('links naming a folder document are pointed at it, others left alone', () => {
  const { root, anchors, hrefs } = fakeLinks(['OUTLINE#act-two', 'Appendix', 'https://x.org']);
  resolveFolderLinks(root, folder, '?full');
  expect(hrefs()).toEqual(['/d/outline?full#act-two', 'Appendix', 'https://x.org']);
  expect(anchors.map(isFolderLink)).toEqual([true, false, false]);
});

test('a later pass re-resolves from what was written, and restores it when nothing matches', () => {
  const { root, anchors, hrefs } = fakeLinks(['OUTLINE']);
  resolveFolderLinks(root, folder, '');
  resolveFolderLinks(root, folder, '?full');
  expect(hrefs()).toEqual(['/d/outline?full']);

  const renamed: DocumentFolder = {
    ...folder,
    documents: folder.documents.filter((d) => d.uid !== 'outline'),
  };
  resolveFolderLinks(root, renamed, '');
  expect(hrefs()).toEqual(['OUTLINE']);
  expect(isFolderLink(anchors[0]!)).toBe(false);
});

test('an attribute in the markup never supplies the href', () => {
  // The sanitizer keeps data-* attributes, so one an author planted must not be read back.
  const { root, hrefs } = fakeLinks(['/d/elsewhere']);
  const link = (root.querySelectorAll('a') as unknown as HTMLAnchorElement[])[0]!;
  link.setAttribute('data-folder-href', 'javascript:alert(1)');
  resolveFolderLinks(root, folder, '');
  resolveFolderLinks(root, null, '');
  expect(hrefs()).toEqual(['/d/elsewhere']);
});
