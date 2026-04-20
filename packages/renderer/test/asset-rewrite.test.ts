import { describe, expect, test } from 'bun:test';
import { render, rewriteAssetReferences } from '../src/index.js';

describe('rewriteAssetReferences', () => {
  test('rewrites attached refs to the proxy URL', async () => {
    const { html } = await render('![alt](cat.png)\n');
    const out = await rewriteAssetReferences(html, {
      docUid: 'DOC123',
      attached: new Set(['cat.png']),
    });
    expect(out).toContain('src="/api/documents/DOC123/assets/cat.png"');
    expect(out).toContain('data-asset-ref="cat.png"');
    expect(out).not.toContain('data-missing-asset');
  });

  test('marks unattached refs with data-missing-asset', async () => {
    const { html } = await render('![cat](cat.png)\n');
    const out = await rewriteAssetReferences(html, {
      docUid: 'DOC123',
      attached: new Set<string>(),
    });
    expect(out).toContain('data-missing-asset="cat.png"');
    expect(out).not.toContain('/api/documents/DOC123/assets/');
  });

  test('leaves absolute URLs alone', async () => {
    const { html } = await render('![x](https://example.com/cat.png)\n');
    const out = await rewriteAssetReferences(html, {
      docUid: 'DOC',
      attached: new Set(),
    });
    expect(out).toContain('src="https://example.com/cat.png"');
    expect(out).not.toContain('data-missing-asset');
  });

  test('leaves root-relative paths alone', async () => {
    const { html } = await render('![x](/static/cat.png)\n');
    const out = await rewriteAssetReferences(html, {
      docUid: 'DOC',
      attached: new Set(),
    });
    expect(out).toContain('src="/static/cat.png"');
    expect(out).not.toContain('data-missing-asset');
  });

  test('keeps subpath separators readable in the rewritten URL', async () => {
    const { html } = await render('![](images/diagram.png)\n');
    const out = await rewriteAssetReferences(html, {
      docUid: 'DOC',
      attached: new Set(['images/diagram.png']),
    });
    expect(out).toContain('src="/api/documents/DOC/assets/images/diagram.png"');
  });

  test('leaves dot-segment paths alone (server rejects them; no dropzone UX)', async () => {
    const { html } = await render('![](../escape.png)\n![](./here.png)\n');
    const out = await rewriteAssetReferences(html, {
      docUid: 'DOC',
      attached: new Set(),
    });
    expect(out).toContain('src="../escape.png"');
    expect(out).toContain('src="./here.png"');
    expect(out).not.toContain('data-missing-asset');
  });
});
