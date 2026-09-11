import { describe, expect, test } from 'bun:test';
import { headingSegmentsMatch, scoreSectionMatch } from '../src/section-score.js';

// Chapter headings a novel repeats: "Elias" opens two sections in chapter
// one and one in chapter five, so the three share an id and a text.
const eliasChapterOneFirst = {
  headingPath: ['Crestwood', 'Chapter 1', 'Elias'],
  sectionIndex: 0,
  sectionIndexPath: [2, 2, 1, 0],
};
const eliasChapterOneSecond = {
  headingPath: ['Crestwood', 'Chapter 1', 'Elias'],
  sectionIndex: 50,
  sectionIndexPath: [74, 74, 73, 50],
};
const eliasChapterFive = {
  headingPath: ['Crestwood', 'Chapter 5', 'Elias'],
  sectionIndex: 0,
  sectionIndexPath: [526, 526, 1, 0],
};

describe('scoreSectionMatch', () => {
  test('an exact heading path outranks every other, nearest position first', () => {
    const path = eliasChapterFive.headingPath;
    const indexPath = eliasChapterFive.sectionIndexPath;
    expect(scoreSectionMatch(eliasChapterFive, path, indexPath)).toBe(10_000);
    expect(scoreSectionMatch(eliasChapterOneFirst, path, indexPath)).toBeLessThan(10_000);
    expect(scoreSectionMatch(eliasChapterOneSecond, path, indexPath)).toBeLessThan(10_000);
  });

  test('the same path twice is settled by distance within the section', () => {
    const path = eliasChapterOneSecond.headingPath;
    const near = scoreSectionMatch(eliasChapterOneSecond, path, [74, 74, 73, 47]);
    const far = scoreSectionMatch(eliasChapterOneFirst, path, [74, 74, 73, 47]);
    expect(near).toBe(10_000 - 3);
    expect(far).toBe(10_000 - 47);
  });

  test('a path stored before the outer heading existed still matches exactly', () => {
    // The browser once walked from the first chapter heading, not the
    // book's title, and grafted the permalink sigil onto every segment.
    const stored = ['#Chapter 5', '#Elias'];
    expect(scoreSectionMatch(eliasChapterFive, stored, [526, 1, 0])).toBe(10_000);
    expect(scoreSectionMatch(eliasChapterOneFirst, stored, [526, 1, 0])).toBeLessThan(10_000);
  });

  test('a renamed innermost heading falls back to position under the surviving parent', () => {
    const stored = ['Crestwood', 'Chapter 5', 'Elias, alone'];
    const score = scoreSectionMatch(eliasChapterFive, stored, [526, 526, 1, 0]);
    // Two levels shared, then no distance at the deepest common level.
    expect(score).toBe(2_000);
    expect(scoreSectionMatch(eliasChapterOneFirst, stored, [526, 526, 1, 0])).toBe(1_000 - 524);
  });

  test('no stored path is no evidence at all', () => {
    expect(scoreSectionMatch(eliasChapterFive, null, null)).toBe(0);
    expect(scoreSectionMatch(eliasChapterFive, [], null)).toBe(10_000);
  });
});

describe('headingSegmentsMatch', () => {
  test('discounts exactly one permalink sigil', () => {
    expect(headingSegmentsMatch('Chapter 4', 'Chapter 4')).toBe(true);
    expect(headingSegmentsMatch('#Chapter 4', 'Chapter 4')).toBe(true);
    expect(headingSegmentsMatch('##Chapter 4', 'Chapter 4')).toBe(false);
    expect(headingSegmentsMatch('##Chapter 4', '#Chapter 4')).toBe(true);
  });
});
