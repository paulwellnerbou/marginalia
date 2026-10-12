import {
  CHAPTER_HIDDEN_ATTR,
  chapterIndexOf,
  REVEAL_CHAPTER_EVENT,
  revealChapterOf,
  showChapter,
} from '../../src/lib/chapter-reading.js';

// The two shapes a chapter takes in the viewer: Markdown's headings with
// the fold wrapper the viewer installs after each one (a book title whose
// wrapper holds every chapter), and AsciiDoc's section containers.
document.body.innerHTML = `
<article class="marginalia" id="md">
  <h1 id="book">Crestwood</h1>
  <div class="collapse-section"><div class="collapse-section-inner">
    <p id="intro">Before anything happens.</p>
    <h2 id="ch1">Chapter 1</h2>
    <div class="collapse-section"><div class="collapse-section-inner">
      <p id="p1">The stable doors swing open.</p>
      <h3 id="ch1-a">Elias</h3>
      <div class="collapse-section"><div class="collapse-section-inner">
        <p id="p1a">He dresses in the dark.</p>
      </div></div>
    </div></div>
    <h2 id="ch2">Chapter 2</h2>
    <div class="collapse-section"><div class="collapse-section-inner">
      <p id="p2">The cold wakes him.</p>
    </div></div>
    <h2 id="ch3">Chapter 3</h2>
    <div class="collapse-section"><div class="collapse-section-inner">
      <p id="p3">Snow by noon.</p>
    </div></div>
  </div></div>
</article>
<article class="marginalia" id="adoc">
  <div id="header"><h1 id="title">Manual</h1></div>
  <div id="preamble"><p id="a0">Read this first.</p></div>
  <div class="sect1"><h2 id="s1">Setup</h2><div class="sectionbody"><p id="a1">Install it.</p></div></div>
  <div class="sect1"><h2 id="s2">Use</h2><div class="sectionbody"><p id="a2">Run it.</p></div></div>
</article>`;

Object.assign(window, {
  chapterReading: {
    CHAPTER_HIDDEN_ATTR,
    chapterIndexOf,
    REVEAL_CHAPTER_EVENT,
    revealChapterOf,
    showChapter,
  },
});
