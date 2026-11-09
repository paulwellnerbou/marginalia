import { describe, expect, test } from 'bun:test';
import { render } from '../src/index.js';

async function paragraphs(md: string): Promise<string[]> {
  const { html } = await render(md);
  return html.match(/<p\b[^>]*>/g) ?? [];
}

describe('image-only paragraphs', () => {
  test('a lone image is marked', async () => {
    expect(await paragraphs('![a](x.png)')).toEqual([
      expect.stringContaining('data-block-kind="image"'),
    ]);
  });

  test('several images, a linked image and hard breaks still count', async () => {
    const [p] = await paragraphs('![a](x.png) [![b](y.png)](https://e.test)  \n![c](z.png)');
    expect(p).toContain('data-block-kind="image"');
  });

  test('an image in running text is not marked', async () => {
    const [p] = await paragraphs('Click the ![gear](gear.png) icon.');
    expect(p).not.toContain('data-block-kind');
  });

  test('a link with text around an image is not marked', async () => {
    const [p] = await paragraphs('[![b](y.png) docs](https://e.test)');
    expect(p).not.toContain('data-block-kind');
  });

  test('a text-only paragraph is not marked', async () => {
    const [p] = await paragraphs('Just words.');
    expect(p).not.toContain('data-block-kind');
  });
});
