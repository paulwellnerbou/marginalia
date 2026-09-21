/// <reference types="bun" />

import { beforeEach, expect, test } from 'bun:test';
import type { DocumentFolder } from './api.js';
import { listTitles, otherFolderUids, replaceFolderToken, shareFolderToken } from './folder.js';
import { loadInviteToken, saveInviteToken } from './invite.js';

beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
});

function folder(...uids: string[]): DocumentFolder {
  return {
    main_uid: uids[0] ?? '',
    documents: uids.map((uid, i) => ({
      uid,
      name: uid,
      title: uid,
      format: 'markdown',
      main: i === 0,
      created_at: i,
      updated_at: i,
    })),
  };
}

test('the token that opens one document is stored for the rest of its folder', () => {
  saveInviteToken('outline', 'admin-token');
  shareFolderToken(folder('story', 'outline', 'background'), 'outline');
  expect(loadInviteToken('story')).toBe('admin-token');
  expect(loadInviteToken('background')).toBe('admin-token');
});

test('a token already stored for a folder document is left alone', () => {
  saveInviteToken('outline', 'admin-token');
  saveInviteToken('story', 'reader-token');
  shareFolderToken(folder('story', 'outline'), 'outline');
  expect(loadInviteToken('story')).toBe('reader-token');
});

test('nothing is shared from a document opened without a token, or standing alone', () => {
  shareFolderToken(folder('story', 'outline'), 'outline');
  expect(loadInviteToken('story')).toBeNull();
  saveInviteToken('lone', 'token');
  shareFolderToken(null, 'lone');
  expect(otherFolderUids(null, 'lone')).toEqual([]);
});

test('a rotated admin token replaces the old one only where it was stored', () => {
  saveInviteToken('story', 'old');
  saveInviteToken('outline', 'old');
  saveInviteToken('background', 'someone-else');
  const changed = replaceFolderToken(['story', 'outline', 'background', 'unseen'], 'old', 'new');
  expect(changed).toEqual(['story', 'outline']);
  expect(loadInviteToken('outline')).toBe('new');
  expect(loadInviteToken('background')).toBe('someone-else');
  expect(loadInviteToken('unseen')).toBeNull();
});

test('titles read as a list in prose', () => {
  expect(listTitles(['OUTLINE'])).toBe('OUTLINE');
  expect(listTitles(['OUTLINE', 'BACKGROUND'])).toBe('OUTLINE and BACKGROUND');
  expect(listTitles(['A', 'B', 'C'])).toBe('A, B and C');
});
