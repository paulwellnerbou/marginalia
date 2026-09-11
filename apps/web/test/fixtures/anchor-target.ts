import { findAnchorBlock, resolveAnchorElement } from '../../src/lib/anchor-target.js';
import { collectTopLevelBlocks, sectionContextsOf } from '../../src/lib/selection.js';

// A document that heads three of its sections with the same name, the way
// the renderer draws one: ids are content hashes, so the repeated heading
// is one id on three elements and the repeated line one id on two; the
// permalink sigil is grafted into every heading; one chapter sits inside
// the viewer's fold wrapper.
const sigil = '<a class="heading-anchor" href="#h">#</a>';
document.body.innerHTML = `
<article class="marginalia" id="doc">
  <h1 data-block="h-book">${sigil}Crestwood</h1>
  <h2 data-block="h-ch1">${sigil}Chapter 1</h2>
  <h3 data-block="h-elias">${sigil}Elias</h3>
  <p data-block="p-1">The stable doors swing open.</p>
  <p data-block="p-mm">"Mm," Clara says.</p>
  <h3 data-block="h-elias">${sigil}Elias</h3>
  <p data-block="p-2">He dresses in the dark.</p>
  <div class="collapse-section">
    <h2 data-block="h-ch2">${sigil}Chapter 2</h2>
    <div class="collapse-section-inner">
      <h3 data-block="h-elias">${sigil}Elias</h3>
      <p data-block="p-3">The cold wakes him before the alarm does.</p>
      <p data-block="p-mm">"Mm," Clara says.</p>
      <ul data-block="list-1"><li data-subblock="li-a">alpha</li><li data-subblock="li-b">beta</li></ul>
    </div>
  </div>
</article>`;

Object.assign(window, {
  anchorTarget: { findAnchorBlock, resolveAnchorElement, collectTopLevelBlocks, sectionContextsOf },
});
