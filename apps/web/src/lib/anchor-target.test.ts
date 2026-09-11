import { describe, expect, test } from 'bun:test';
import { chooseBySection } from './anchor-target.js';

// The ten "Elias" headings of a novel share one id; a note on the fifth is
// told from a note on the first only by the section it stored.
const headings = [
  { n: 1, headingPath: ['Crestwood', 'Chapter 1', 'Elias'], sectionIndexPath: [2, 2, 1, 0] },
  { n: 2, headingPath: ['Crestwood', 'Chapter 1', 'Elias'], sectionIndexPath: [74, 74, 73, 50] },
  { n: 3, headingPath: ['Crestwood', 'Chapter 2', 'Elias'], sectionIndexPath: [140, 140, 1, 0] },
  { n: 4, headingPath: ['Crestwood', 'Chapter 2', 'Elias'], sectionIndexPath: [156, 156, 17, 11] },
  { n: 5, headingPath: ['Crestwood', 'Chapter 5', 'Elias'], sectionIndexPath: [526, 526, 1, 0] },
  { n: 6, headingPath: ['Crestwood', 'Chapter 5', 'Elias'], sectionIndexPath: [616, 616, 91, 6] },
].map((h) => ({ ...h, sectionIndex: h.sectionIndexPath[h.sectionIndexPath.length - 1]! }));

const sectionOf = (h: (typeof headings)[number]) => h;

describe('chooseBySection', () => {
  test('the stored section picks the heading the note was written on', () => {
    for (const heading of headings) {
      const chosen = chooseBySection(headings, sectionOf, {
        heading_path: heading.headingPath,
        section_index: heading.sectionIndex,
        section_index_path: heading.sectionIndexPath,
      });
      expect(chosen?.n).toBe(heading.n);
    }
  });

  test('a note the browser wrote before the title joined the walk still lands right', () => {
    const chosen = chooseBySection(headings, sectionOf, {
      heading_path: ['#Chapter 5', '#Elias'],
      section_index: 6,
      section_index_path: [616, 91, 6],
    });
    expect(chosen?.n).toBe(6);
  });

  test('a position that drifted a little still means the nearest heading of that path', () => {
    const chosen = chooseBySection(headings, sectionOf, {
      heading_path: ['Crestwood', 'Chapter 5', 'Elias'],
      section_index: 2,
      section_index_path: [526, 526, 1, 2],
    });
    expect(chosen?.n).toBe(5);
  });

  test('without a stored section the first is all there is to choose', () => {
    expect(chooseBySection(headings, sectionOf, null)?.n).toBe(1);
    expect(chooseBySection(headings, sectionOf, { heading_path: null })?.n).toBe(1);
  });

  test('a lone candidate is chosen without looking', () => {
    expect(chooseBySection([headings[4]!], () => null, { heading_path: ['x'] })?.n).toBe(5);
    expect(chooseBySection([], sectionOf, { heading_path: ['x'] })).toBeNull();
  });
});
