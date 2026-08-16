import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { type App, createApp } from '../src/app.js';
import { CLIENT_HEADER, CLIENT_NAME_HEADER, INVITE_HEADER } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

const ALICE = { id: 'aaaaaaaaaaaaaaaaaaaa', name: 'Alice' };
const BOB = { id: 'bbbbbbbbbbbbbbbbbbbb', name: 'Bob' };

function headers(c: { id: string; name: string }, extra: Record<string, string> = {}) {
  return new Headers({
    [CLIENT_HEADER]: c.id,
    [CLIENT_NAME_HEADER]: c.name,
    ...extra,
  });
}

function multipartHeaders(c: { id: string; name: string }, invite?: string) {
  const h = new Headers({ [CLIENT_HEADER]: c.id, [CLIENT_NAME_HEADER]: c.name });
  if (invite) h.set(INVITE_HEADER, invite);
  return h;
}

describe('assets API', () => {
  let dir: string;
  let webDir: string;
  let app: App;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-srv-'));
    webDir = mkdtempSync(join(tmpdir(), 'mdn-web-'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html>');
    app = await createApp(loadConfig({ dataDir: dir, port: 0, webDir }));
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(webDir, { recursive: true, force: true });
  });

  async function upload() {
    const res = await app.hono.fetch(
      new Request('http://test/api/documents', {
        method: 'POST',
        headers: headers(ALICE, { 'content-type': 'application/json' }),
        // Opt out of the invite-only default: these cases are about asset
        // permissions, and want a document a plain reader can reach.
        body: JSON.stringify({ source: '# Hi\n\n![](cat.png)\n', invite_only: false }),
      }),
    );
    return (await res.json()) as {
      uid: string;
      admin_invite: { token: string };
    };
  }

  async function putAsset(
    uid: string,
    token: string,
    refName: string,
    bytes: Uint8Array,
    mime = 'image/png',
    client = ALICE,
  ): Promise<Response> {
    const form = new FormData();
    form.append('file', new Blob([bytes as BlobPart], { type: mime }), refName);
    form.append('ref_name', refName);
    return app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/assets`, {
        method: 'POST',
        headers: multipartHeaders(client, token),
        body: form,
      }),
    );
  }

  test('admin can upload an asset, fetch it, list it, and delete it', async () => {
    const doc = await upload();
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
    const up = await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', bytes);
    expect(up.status).toBe(201);
    const body = (await up.json()) as { asset: { ref_name: string; size: number; mime: string } };
    expect(body.asset.ref_name).toBe('cat.png');
    expect(body.asset.size).toBe(bytes.length);
    expect(body.asset.mime).toBe('image/png');

    const get = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
        method: 'GET',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/png');
    const out = new Uint8Array(await get.arrayBuffer());
    expect(out.length).toBe(bytes.length);
    for (let i = 0; i < bytes.length; i++) expect(out[i]).toBe(bytes[i]!);

    const list = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets`, {
        method: 'GET',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { assets: Array<{ ref_name: string }> };
    expect(listed.assets.map((a) => a.ref_name)).toEqual(['cat.png']);

    const del = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
        method: 'DELETE',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(del.status).toBe(204);

    const missing = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
        method: 'GET',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(missing.status).toBe(404);
  });

  test('copying a document carries its attachments onto the same stored bytes', async () => {
    const doc = await upload();
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
    expect((await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', bytes)).status).toBe(201);

    const copyRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/copy`, {
        method: 'POST',
        headers: headers(ALICE, {
          'content-type': 'application/json',
          [INVITE_HEADER]: doc.admin_invite.token,
        }),
        body: JSON.stringify({ name: 'Hi - Copy' }),
      }),
    );
    expect(copyRes.status).toBe(201);
    const copy = (await copyRes.json()) as { uid: string; admin_invite: { token: string } };

    const onCopy = await app.hono.fetch(
      new Request(`http://test/api/documents/${copy.uid}/assets/cat.png`, {
        headers: headers(ALICE, { [INVITE_HEADER]: copy.admin_invite.token }),
      }),
    );
    expect(onCopy.status).toBe(200);
    expect(new Uint8Array(await onCopy.arrayBuffer()).length).toBe(bytes.length);

    // Both attachments name the same content-addressed blob, so detaching
    // the source's must not GC the bytes out from under the copy.
    const del = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
        method: 'DELETE',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(del.status).toBe(204);
    const stillThere = await app.hono.fetch(
      new Request(`http://test/api/documents/${copy.uid}/assets/cat.png`, {
        headers: headers(ALICE, { [INVITE_HEADER]: copy.admin_invite.token }),
      }),
    );
    expect(stillThere.status).toBe(200);
  });

  test('replacing an attachment on the source leaves the copy on the original bytes', async () => {
    const doc = await upload();
    const original = new Uint8Array([137, 80, 78, 71, 1, 1, 1, 1]);
    expect((await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', original)).status).toBe(201);

    const copyRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/copy`, {
        method: 'POST',
        headers: headers(ALICE, {
          'content-type': 'application/json',
          [INVITE_HEADER]: doc.admin_invite.token,
        }),
        body: JSON.stringify({ name: 'Hi - Copy' }),
      }),
    );
    expect(copyRes.status).toBe(201);
    const copy = (await copyRes.json()) as { uid: string; admin_invite: { token: string } };

    // "Changing the image" is a replace under the same ref name. Blobs are
    // keyed by their own sha256, so the new bytes land beside the old ones
    // and only the source's junction row is repointed — the copy is a
    // separate document, and keeps what it was copied with.
    const replacement = new Uint8Array([137, 80, 78, 71, 9, 9, 9, 9, 9, 9]);
    expect((await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', replacement)).status).toBe(
      201,
    );

    const onSource = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(new Uint8Array(await onSource.arrayBuffer())).toEqual(replacement);

    // The replace detaches the old asset and GCs it if orphaned — which it
    // is not, because the copy still names it.
    const onCopy = await app.hono.fetch(
      new Request(`http://test/api/documents/${copy.uid}/assets/cat.png`, {
        headers: headers(ALICE, { [INVITE_HEADER]: copy.admin_invite.token }),
      }),
    );
    expect(onCopy.status).toBe(200);
    expect(new Uint8Array(await onCopy.arrayBuffer())).toEqual(original);
  });

  describe('invite-only documents: the image cookie', () => {
    /** An invite-only doc with one attached image, plus its admin token. */
    async function privateDocWithImage() {
      const res = await app.hono.fetch(
        new Request('http://test/api/documents', {
          method: 'POST',
          headers: headers(ALICE, { 'content-type': 'application/json' }),
          body: JSON.stringify({ source: '# Private\n\n![](cat.png)\n' }),
        }),
      );
      const doc = (await res.json()) as { uid: string; admin_invite: { token: string } };
      const put = await putAsset(
        doc.uid,
        doc.admin_invite.token,
        'cat.png',
        new Uint8Array([137, 80, 78, 71]),
      );
      expect(put.status).toBe(201);
      return doc;
    }

    /** The `Set-Cookie` this request got back, as a `Cookie` header value. */
    function cookieFrom(res: Response): string {
      const raw = res.headers.get('set-cookie') ?? '';
      return raw.split(';')[0] ?? '';
    }

    test('reading the document hands back a cookie scoped to that document', async () => {
      const doc = await privateDocWithImage();
      const read = await app.hono.fetch(
        new Request(`http://test/api/documents/${doc.uid}`, {
          headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
        }),
      );
      expect(read.status).toBe(200);
      const setCookie = read.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('marginalia_invite_token=');
      // Path-scoped, so a person holding many documents does not send a
      // cookie per document on every request.
      expect(setCookie).toContain(`Path=/api/documents/${doc.uid}`);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
    });

    test('an image loads with only that cookie — what an <img> can actually send', async () => {
      const doc = await privateDocWithImage();
      const read = await app.hono.fetch(
        new Request(`http://test/api/documents/${doc.uid}`, {
          headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
        }),
      );
      const cookie = cookieFrom(read);

      // No invite header, no identity — an <img> sends neither.
      const img = await app.hono.fetch(
        new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
          headers: new Headers({ cookie }),
        }),
      );
      expect(img.status).toBe(200);
      expect(img.headers.get('content-type')).toBe('image/png');

      // And without it the document is as closed as before.
      const bare = await app.hono.fetch(
        new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`),
      );
      expect(bare.status).toBe(401);
    });

    test('the cookie opens that document only, not another one', async () => {
      const mine = await privateDocWithImage();
      const theirs = await privateDocWithImage();
      const read = await app.hono.fetch(
        new Request(`http://test/api/documents/${mine.uid}`, {
          headers: headers(ALICE, { [INVITE_HEADER]: mine.admin_invite.token }),
        }),
      );
      const cookie = cookieFrom(read);

      // Path scoping keeps a real browser from ever sending it here; the
      // server must refuse it anyway, because a hand-made request can.
      const crossed = await app.hono.fetch(
        new Request(`http://test/api/documents/${theirs.uid}/assets/cat.png`, {
          headers: new Headers({ cookie }),
        }),
      );
      expect(crossed.status).toBe(401);
    });

    test('revoking the invite stops the cookie working', async () => {
      const doc = await privateDocWithImage();
      const mk = await app.hono.fetch(
        new Request(`http://test/api/documents/${doc.uid}/invites`, {
          method: 'POST',
          headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
          body: JSON.stringify({ display_name: 'Bob', role: 'reader' }),
        }),
      );
      const { invite } = (await mk.json()) as { invite: { token: string } };

      const read = await app.hono.fetch(
        new Request(`http://test/api/documents/${doc.uid}`, {
          headers: headers(BOB, { [INVITE_HEADER]: invite.token }),
        }),
      );
      const cookie = cookieFrom(read);
      const before = await app.hono.fetch(
        new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
          headers: new Headers({ cookie }),
        }),
      );
      expect(before.status).toBe(200);

      const revoke = await app.hono.fetch(
        new Request(`http://test/api/documents/${doc.uid}/invites/${invite.token}`, {
          method: 'DELETE',
          headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
        }),
      );
      expect(revoke.status).toBe(204);

      // The cookie is only ever a token: revoking the row it names closes
      // the door, no cookie expiry needed.
      const after = await app.hono.fetch(
        new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
          headers: new Headers({ cookie }),
        }),
      );
      expect(after.status).toBe(401);
    });

    test('the cookie fetches bytes but cannot write them', async () => {
      const doc = await privateDocWithImage();
      const read = await app.hono.fetch(
        new Request(`http://test/api/documents/${doc.uid}`, {
          headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
        }),
      );
      const cookie = cookieFrom(read);

      const form = new FormData();
      form.append('file', new Blob([new Uint8Array([1, 2])], { type: 'image/png' }), 'evil.png');
      form.append('ref_name', 'evil.png');
      const upload = await app.hono.fetch(
        new Request(`http://test/api/documents/${doc.uid}/assets`, {
          method: 'POST',
          headers: new Headers({ cookie }),
          body: form,
        }),
      );
      expect(upload.status).toBe(401);

      const remove = await app.hono.fetch(
        new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
          method: 'DELETE',
          headers: new Headers({ cookie }),
        }),
      );
      expect(remove.status).toBe(401);
    });

    test('the cookie does not open the document itself', async () => {
      const doc = await privateDocWithImage();
      const read = await app.hono.fetch(
        new Request(`http://test/api/documents/${doc.uid}`, {
          headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
        }),
      );
      const cookie = cookieFrom(read);

      const body = await app.hono.fetch(
        new Request(`http://test/api/documents/${doc.uid}`, {
          headers: new Headers({ cookie }),
        }),
      );
      expect(body.status).toBe(401);
      expect((await body.json()) as { error: string }).toEqual({ error: 'invite-required' });
    });

    test('an open document sets no such cookie for an anonymous reader', async () => {
      const doc = await upload();
      const read = await app.hono.fetch(
        new Request(`http://test/api/documents/${doc.uid}`, { headers: headers(BOB) }),
      );
      expect(read.status).toBe(200);
      expect(read.headers.get('set-cookie') ?? '').not.toContain('marginalia_invite_token');
    });
  });

  test('upload requires editor role — plain reader is forbidden', async () => {
    const doc = await upload();
    const bytes = new Uint8Array([1, 2, 3]);
    // Bob without an invite is a reader.
    const res = await putAsset(doc.uid, '', 'cat.png', bytes, 'image/png', BOB);
    expect(res.status).toBe(403);
  });

  test('GET without invite is forbidden when doc is password-protected', async () => {
    const created = await app.hono.fetch(
      new Request('http://test/api/documents', {
        method: 'POST',
        headers: headers(ALICE, { 'content-type': 'application/json' }),
        body: JSON.stringify({ source: '# secret', password_protected: true, invite_only: false }),
      }),
    );
    const info = (await created.json()) as { uid: string; admin_invite: { token: string } };
    const bytes = new Uint8Array([1, 2]);
    await putAsset(info.uid, info.admin_invite.token, 'pic.png', bytes);

    // No session: anonymous GET should be rejected before hitting the blob.
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${info.uid}/assets/pic.png`, {
        method: 'GET',
        headers: headers(BOB),
      }),
    );
    expect(res.status).toBe(401);
  });

  test('uploading twice with the same ref_name replaces the attachment', async () => {
    const doc = await upload();
    const v1 = new Uint8Array([1, 2]);
    const v2 = new Uint8Array([3, 4, 5, 6]);
    await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', v1);
    const r2 = await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', v2);
    expect(r2.status).toBe(201);

    const get = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
        method: 'GET',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    const out = new Uint8Array(await get.arrayBuffer());
    expect(out.length).toBe(v2.length);
  });

  // --- book cover ----------------------------------------------------

  /** Small decodable images: upload now validates and thumbnails the payload. */
  const PNG_BYTES = new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAHgAAAC0CAIAAADQLH9KAAAACXBIWXMAAAPoAAAD6AG1e1JrAAACUElEQVR4nO3UUY0DARTDwIJYYAVm0CXQ316eTiMFgeX49byz5/cQXig/f6Ia0AHdf3obowO6uYaMbg5OOro5jQ7o5hoyujk46ejmNDqgm2vI6ObgpKOb0+iAbq4ho5uDk45uTqMDurmGjG4OTjq6OY0O6OYaMro5OOno5jQ6oJtryOjm4KSjm9PogG6uIaObg5OObk6jA7q5hoxuDk46ujmNDujmGjK6OTjp6OY0OqCba8jo5uCko5vT6IBuriGjm4OTjm5OowO6uYaMbg5OOro5jQ7o5hoyujk46ejmNDqgm2vI6ObgpKOb0+iAbq4ho5uDk45uTqMDurmGjG4OTjq6OY0O6OYaMro5OOno5jQ6oJtryOjm4KSjm9PogG6uIaObg5OObk6jA7q5hoxuDk46ujmNDujmGjK6OTjp6OY0OqCba8jo5uCko5vT6IBuriGjm4OTjm5OowO6uYaMbg5OOro5jQ7o5hoyujk46ejmNDqgm2vI6ObgpKOb0+iAbq4ho5uDk45uTqMDurmGjG4OTjq6OY0O6OYaMro5OOno5jQ6oJtryOjm4KSjm9PogG6uIaObg5OObk6jA7q5hoxuDk46ujmNDujmGjK6OTjp6OY0OqCba8jo5uCko5vT6IBuriGjm4OTjm5OowO6uYaMbg5OOro5jQ7o5hoyujk46ejmNDqgm2vI6ObgpKOb0+iAbq4ho5uDk45uTqMDurmGjG4OTjq6OY0O6OYaMro5OOno5jQ6oJtryOjm4KSjm9PogG6uIaObg5OO5ky/7gOPhR6i3oADUwAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  const WEBP_BYTES = new Uint8Array(
    Buffer.from(
      'UklGRngAAABXRUJQVlA4IGwAAACwCACdASp4ALQAPm02mUmkIyKhIGgAgA2JaW7hdflwH4AAAO6HVUmyYh1VJsmIdVSbJiHVUmyYh1VJsmIdVSbJiHVUmyYh1VJsmIdVNgAA/v8Kvf//izkYjs83//wPy6cKKWwmWIQAAAAAAAA=',
      'base64',
    ),
  );

  async function putCover(
    uid: string,
    token: string,
    bytes: Uint8Array,
    fileName = 'my-cover.png',
    client = ALICE,
  ): Promise<Response> {
    const form = new FormData();
    form.append('file', new Blob([bytes as BlobPart]), fileName);
    return app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/cover`, {
        method: 'PUT',
        headers: multipartHeaders(client, token),
        body: form,
      }),
    );
  }

  function getDoc(uid: string, token: string) {
    return app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, {
        method: 'GET',
        headers: headers(ALICE, { [INVITE_HEADER]: token }),
      }),
    );
  }

  test('cover is stored as a document asset and reported by GET /:uid', async () => {
    const doc = await upload();
    const put = await putCover(doc.uid, doc.admin_invite.token, PNG_BYTES);
    expect(put.status).toBe(201);
    const stored = (await put.json()) as {
      cover: {
        ref_name: string;
        mime: string;
        thumbnail: { ref_name: string; asset_id: string; mime: string } | null;
      };
    };
    // Reserved ref name derived from the sniffed format, not the
    // uploaded filename — the served Content-Type comes from the
    // extension, so the two must agree.
    expect(stored.cover.ref_name).toBe('cover.png');
    expect(stored.cover.mime).toBe('image/png');
    expect(stored.cover.thumbnail?.ref_name).toBe('__marginalia-cover-thumbnail.webp');
    expect(stored.cover.thumbnail?.mime).toBe('image/webp');

    const payload = (await (await getDoc(doc.uid, doc.admin_invite.token)).json()) as {
      cover: {
        ref_name: string;
        asset_id: string;
        thumbnail: { ref_name: string; asset_id: string } | null;
      } | null;
      attached_assets: Array<{ ref_name: string }>;
    };
    expect(payload.cover?.ref_name).toBe('cover.png');
    expect(payload.attached_assets.map((a) => a.ref_name)).toContain('cover.png');
    expect(payload.attached_assets.map((a) => a.ref_name)).not.toContain(
      '__marginalia-cover-thumbnail.webp',
    );

    // Fetchable through the ordinary asset proxy.
    const get = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/cover.png`, {
        method: 'GET',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(PNG_BYTES);

    const thumbnail = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/__marginalia-cover-thumbnail.webp`, {
        method: 'GET',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/webp');
    expect(Number(thumbnail.headers.get('content-length'))).toBeGreaterThan(0);
    expect(await sharp(await thumbnail.arrayBuffer()).metadata()).toMatchObject({
      format: 'webp',
      width: 192,
      height: 288,
    });
  });

  test('replacing a cover with another format detaches the old ref', async () => {
    const doc = await upload();
    await putCover(doc.uid, doc.admin_invite.token, PNG_BYTES);
    const put = await putCover(doc.uid, doc.admin_invite.token, WEBP_BYTES, 'other.webp');
    expect(put.status).toBe(201);

    const payload = (await (await getDoc(doc.uid, doc.admin_invite.token)).json()) as {
      cover: { ref_name: string } | null;
      attached_assets: Array<{ ref_name: string }>;
    };
    expect(payload.cover?.ref_name).toBe('cover.webp');
    expect(payload.attached_assets.map((a) => a.ref_name)).not.toContain('cover.png');
  });

  test('DELETE /:uid/cover clears the pointer and the asset', async () => {
    const doc = await upload();
    await putCover(doc.uid, doc.admin_invite.token, PNG_BYTES);
    const del = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/cover`, {
        method: 'DELETE',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(del.status).toBe(204);

    const payload = (await (await getDoc(doc.uid, doc.admin_invite.token)).json()) as {
      cover: unknown;
      attached_assets: Array<{ ref_name: string }>;
    };
    expect(payload.cover).toBeNull();
    expect(payload.attached_assets.map((a) => a.ref_name)).not.toContain('cover.png');
    expect(
      (
        app.db
          .prepare('SELECT count(*) AS count FROM document_assets WHERE doc_uid = ?')
          .get(doc.uid) as { count: number }
      ).count,
    ).toBe(0);
  });

  test('deleting the cover asset through the generic route clears cover_ref', async () => {
    const doc = await upload();
    await putCover(doc.uid, doc.admin_invite.token, PNG_BYTES);
    const del = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/cover.png`, {
        method: 'DELETE',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(del.status).toBe(204);

    const payload = (await (await getDoc(doc.uid, doc.admin_invite.token)).json()) as {
      cover: unknown;
    };
    expect(payload.cover).toBeNull();
    expect(
      (
        app.db
          .prepare('SELECT count(*) AS count FROM document_assets WHERE doc_uid = ?')
          .get(doc.uid) as { count: number }
      ).count,
    ).toBe(0);
  });

  test('cover upload rejects non-image bytes and requires editor role', async () => {
    const doc = await upload();
    const notAnImage = await putCover(
      doc.uid,
      doc.admin_invite.token,
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    );
    expect(notAnImage.status).toBe(400);
    expect(((await notAnImage.json()) as { error: string }).error).toBe('unsupported-cover-image');

    // Bob has no invite → reader.
    const asReader = await putCover(doc.uid, '', PNG_BYTES, 'my-cover.png', BOB);
    expect(asReader.status).toBe(403);
  });

  test('GET /api/documents/:uid returns attached_assets and rewrites <img src>', async () => {
    const doc = await upload();
    const bytes = new Uint8Array([9, 9, 9]);
    const uploadRes = await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', bytes);
    const uploaded = (await uploadRes.json()) as { asset: { asset_id: string } };

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}`, {
        method: 'GET',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      rendered: { html: string };
      attached_assets: Array<{ ref_name: string }>;
    };
    expect(payload.attached_assets.map((a) => a.ref_name)).toEqual(['cat.png']);
    expect(payload.rendered.html).toContain(
      `/api/documents/${doc.uid}/assets/cat.png?v=${uploaded.asset.asset_id}`,
    );
    expect(payload.rendered.html).not.toContain('data-missing-asset="cat.png"');
  });

  test('GET /api/documents/:uid tags unattached refs with data-missing-asset', async () => {
    const doc = await upload();
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}`, {
        method: 'GET',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    const payload = (await res.json()) as { rendered: { html: string } };
    expect(payload.rendered.html).toContain('data-missing-asset="cat.png"');
  });

  test('delete cleans up the blob when no other document references it', async () => {
    const doc = await upload();
    const bytes = new Uint8Array([42, 42, 42, 42]);
    await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', bytes);
    expect((app.db.prepare('SELECT COUNT(*) as c FROM assets').get() as { c: number }).c).toBe(1);

    const del = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
        method: 'DELETE',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(del.status).toBe(204);
    expect((app.db.prepare('SELECT COUNT(*) as c FROM assets').get() as { c: number }).c).toBe(0);
  });

  test('replace upload GCs the previous blob if nothing else points to it', async () => {
    const doc = await upload();
    await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', new Uint8Array([1]));
    const beforeIds = new Set(
      (app.db.prepare('SELECT id FROM assets').all() as Array<{ id: string }>).map((r) => r.id),
    );
    await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', new Uint8Array([2, 2]));
    const afterIds = new Set(
      (app.db.prepare('SELECT id FROM assets').all() as Array<{ id: string }>).map((r) => r.id),
    );
    // Exactly one row; the old id was swept.
    expect(afterIds.size).toBe(1);
    expect([...afterIds][0]).not.toBe([...beforeIds][0]);
  });

  test('deleting a document cascades to its assets', async () => {
    const doc = await upload();
    await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', new Uint8Array([9, 9]));
    const del = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}`, {
        method: 'DELETE',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(del.status).toBe(204);
    expect(
      (app.db.prepare('SELECT COUNT(*) as c FROM document_assets').get() as { c: number }).c,
    ).toBe(0);
    expect((app.db.prepare('SELECT COUNT(*) as c FROM assets').get() as { c: number }).c).toBe(0);
  });

  test('stored mime is derived from ref_name, ignoring the client-sent type', async () => {
    const doc = await upload();
    // Lie about the content: client says text/html, server must ignore it
    // and use the .png extension from ref_name → image/png.
    const up = await putAsset(
      doc.uid,
      doc.admin_invite.token,
      'cat.png',
      new Uint8Array([1, 2, 3]),
      'text/html',
    );
    expect(up.status).toBe(201);
    const body = (await up.json()) as { asset: { mime: string } };
    expect(body.asset.mime).toBe('image/png');
  });

  test('GET sends X-Content-Type-Options: nosniff', async () => {
    const doc = await upload();
    await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', new Uint8Array([1]));
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
        method: 'GET',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('GET images stay inline; unknown/non-image mimes get attachment disposition', async () => {
    const doc = await upload();
    await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', new Uint8Array([1]));
    // Unknown extension → application/octet-stream → must force download.
    await putAsset(
      doc.uid,
      doc.admin_invite.token,
      'data.bin',
      new Uint8Array([1]),
      'application/octet-stream',
    );

    const img = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
        method: 'GET',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(img.headers.get('content-disposition')).toBeNull();

    const bin = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/data.bin`, {
        method: 'GET',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(bin.headers.get('content-disposition')).toBe('attachment');
  });

  test('DELETE requires an identity (matches upload + updateDocument)', async () => {
    const doc = await upload();
    await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', new Uint8Array([1]));
    // An invite alone isn't enough — the request must carry identity
    // headers too. Send only the invite token, no CLIENT_HEADER.
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
        method: 'DELETE',
        headers: new Headers({ [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('identity-required');
  });

  test('GET sends Cache-Control: must-revalidate so revoked access is re-checked', async () => {
    const doc = await upload();
    await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', new Uint8Array([1, 2]));
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
        method: 'GET',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(res.status).toBe(200);
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toContain('must-revalidate');
    expect(cc).toContain('max-age=0');
    expect(cc).toContain('private');
  });

  test('refuses path traversal in ref_name', async () => {
    const doc = await upload();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'x.png');
    form.append('ref_name', '../escape.png');
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets`, {
        method: 'POST',
        headers: multipartHeaders(ALICE, doc.admin_invite.token),
        body: form,
      }),
    );
    expect(res.status).toBe(400);
  });

  test('refuses ref_names with URL-reserved chars (cannot round-trip)', async () => {
    const doc = await upload();
    for (const bad of ['cat?.png', 'cat#.png', 'img\\path.png', 'foo:bar.png']) {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'x.png');
      form.append('ref_name', bad);
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${doc.uid}/assets`, {
          method: 'POST',
          headers: multipartHeaders(ALICE, doc.admin_invite.token),
          body: form,
        }),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('ref_name-invalid');
    }
  });

  test('refuses ref_names with empty path segments (proxies collapse //)', async () => {
    const doc = await upload();
    for (const bad of ['images//a.png', 'trailing/']) {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'x.png');
      form.append('ref_name', bad);
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${doc.uid}/assets`, {
          method: 'POST',
          headers: multipartHeaders(ALICE, doc.admin_invite.token),
          body: form,
        }),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('ref_name-invalid');
    }
  });

  test('missing ref_name returns ref_name-required, not ref_name-invalid', async () => {
    const doc = await upload();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'x.png');
    // no ref_name field
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets`, {
        method: 'POST',
        headers: multipartHeaders(ALICE, doc.admin_invite.token),
        body: form,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('ref_name-required');
  });

  test('If-None-Match honors weak validators and comma-separated lists', async () => {
    const doc = await upload();
    await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', new Uint8Array([42]));

    const first = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
        method: 'GET',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();

    // Weak ETag: W/"..." should still match the strong server tag.
    const weak = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
        method: 'GET',
        headers: headers(ALICE, {
          [INVITE_HEADER]: doc.admin_invite.token,
          'If-None-Match': `W/${etag}`,
        }),
      }),
    );
    expect(weak.status).toBe(304);

    // Comma-separated list with our ETag included → 304.
    const list = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
        method: 'GET',
        headers: headers(ALICE, {
          [INVITE_HEADER]: doc.admin_invite.token,
          'If-None-Match': `"other-tag", ${etag}, "third"`,
        }),
      }),
    );
    expect(list.status).toBe(304);

    // Wildcard: matches any existing resource.
    const wildcard = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
        method: 'GET',
        headers: headers(ALICE, {
          [INVITE_HEADER]: doc.admin_invite.token,
          'If-None-Match': '*',
        }),
      }),
    );
    expect(wildcard.status).toBe(304);
  });
});
