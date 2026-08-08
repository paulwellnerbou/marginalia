import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type App, createApp } from '../src/app.js';
import { CLIENT_HEADER, CLIENT_NAME_HEADER, INVITE_HEADER } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { newPairingCode } from '../src/ids.js';
import { KEYRING_HEADER, normalizePairingCode } from '../src/routes/keyrings.js';

const LAPTOP = { id: 'aaaaaaaaaaaaaaaaaaaa', name: 'Paul' };
const PHONE = { id: 'bbbbbbbbbbbbbbbbbbbb', name: 'Misty Owl' };

function headersFor(
  client: { id: string; name: string },
  extra: Record<string, string> = {},
): Headers {
  return new Headers({
    'content-type': 'application/json',
    [CLIENT_HEADER]: client.id,
    [CLIENT_NAME_HEADER]: client.name,
    ...extra,
  });
}

interface CreateResponse {
  uid: string;
  admin_invite: { token: string; url: string; display_name: string };
}

interface KeyringWire {
  token: string;
  client_id: string;
  display_name: string;
  docs: Array<{
    doc_uid: string;
    invite_token: string;
    title: string | null;
    role: string | null;
    format: string;
    password_protected: boolean;
    cover: { ref_name: string; asset_id: string; mime: string } | null;
  }>;
}

describe('keyrings API', () => {
  let dir: string;
  let webDir: string;
  let app: App;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-keyring-'));
    webDir = mkdtempSync(join(tmpdir(), 'mdn-keyring-web-'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>');
    app = await createApp(loadConfig({ dataDir: dir, port: 0, webDir }));
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(webDir, { recursive: true, force: true });
  });

  async function upload(
    client: typeof LAPTOP,
    body: Record<string, unknown> = { markdown: '# Hi' },
  ): Promise<CreateResponse> {
    const res = await app.hono.fetch(
      new Request('http://test/api/documents', {
        method: 'POST',
        headers: headersFor(client),
        body: JSON.stringify(body),
      }),
    );
    expect(res.status).toBe(201);
    return (await res.json()) as CreateResponse;
  }

  async function createKeyring(
    client: typeof LAPTOP,
    docs: Array<{ doc_uid: string; invite_token: string; title?: string }> = [],
  ): Promise<KeyringWire> {
    const res = await app.hono.fetch(
      new Request('http://test/api/keyrings', {
        method: 'POST',
        headers: headersFor(client),
        body: JSON.stringify({ docs }),
      }),
    );
    expect(res.status).toBe(201);
    return (await res.json()) as KeyringWire;
  }

  function ringHeaders(client: typeof LAPTOP, token: string): Headers {
    return headersFor(client, { [KEYRING_HEADER]: token });
  }

  async function putDoc(
    token: string,
    docUid: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return app.hono.fetch(
      new Request(`http://test/api/keyrings/self/docs/${docUid}`, {
        method: 'PUT',
        headers: ringHeaders(LAPTOP, token),
        body: JSON.stringify(body),
      }),
    );
  }

  async function mintPairing(token: string): Promise<{ code: string; expires_at: number }> {
    const res = await app.hono.fetch(
      new Request('http://test/api/keyrings/self/pairings', {
        method: 'POST',
        headers: ringHeaders(LAPTOP, token),
      }),
    );
    expect(res.status).toBe(201);
    return (await res.json()) as { code: string; expires_at: number };
  }

  /** Rows a ring still owns, for assertions the HTTP surface can't make. */
  function countFor(
    target: App,
    table: 'keyring_docs' | 'keyring_pairings',
    token: string,
  ): number {
    const { n } = target.db
      .prepare(`SELECT count(*) AS n FROM ${table} WHERE keyring_token = ?`)
      .get(token) as { n: number };
    return n;
  }

  async function redeem(code: string): Promise<Response> {
    return app.hono.fetch(
      new Request('http://test/api/pairings/redeem', {
        method: 'POST',
        headers: headersFor(PHONE),
        body: JSON.stringify({ code }),
      }),
    );
  }

  test('creating a keyring adopts the calling device identity and seeds its documents', async () => {
    const doc = await upload(LAPTOP);
    const ring = await createKeyring(LAPTOP, [
      { doc_uid: doc.uid, invite_token: doc.admin_invite.token, title: 'Notes' },
    ]);

    expect(ring.client_id).toBe(LAPTOP.id);
    expect(ring.display_name).toBe('Paul');
    expect(ring.docs).toHaveLength(1);
    expect(ring.docs[0]?.doc_uid).toBe(doc.uid);
    expect(ring.docs[0]?.title).toBe('Notes');
    expect(ring.docs[0]?.role).toBe('admin');
  });

  test('a keyring token grants no access to the documents it holds', async () => {
    const doc = await upload(LAPTOP);
    const ring = await createKeyring(LAPTOP, [
      { doc_uid: doc.uid, invite_token: doc.admin_invite.token },
    ]);

    // Presenting the keyring instead of the invite must not read as admin
    // — the keyring is a store of credentials, never a credential.
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}`, {
        headers: ringHeaders(PHONE, ring.token),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe('reader');
  });

  test('pairing hands the ring to a second device, once', async () => {
    const doc = await upload(LAPTOP, { markdown: '# Shared', name: 'Shared doc' });
    const ring = await createKeyring(LAPTOP, [
      { doc_uid: doc.uid, invite_token: doc.admin_invite.token, title: 'Shared doc' },
    ]);
    const { code } = await mintPairing(ring.token);

    const first = await redeem(code);
    expect(first.status).toBe(200);
    const paired = (await first.json()) as KeyringWire;
    expect(paired.token).toBe(ring.token);
    // The phone adopts the laptop's identity — that is what makes the two
    // devices one person rather than two users with the same name.
    expect(paired.client_id).toBe(LAPTOP.id);
    expect(paired.display_name).toBe('Paul');
    expect(paired.docs[0]?.invite_token).toBe(doc.admin_invite.token);

    const second = await redeem(code);
    expect(second.status).toBe(404);
  });

  test('pairing codes are accepted in whatever shape they are retyped', async () => {
    const ring = await createKeyring(LAPTOP);
    const { code } = await mintPairing(ring.token);
    const retyped = code.replace('-', '').toLowerCase();

    const res = await redeem(retyped);
    expect(res.status).toBe(200);
  });

  test('an expired pairing code is refused', async () => {
    const expiringApp = await createApp(
      loadConfig({ dataDir: dir, port: 0, webDir, keyringPairingTtlMs: -1 }),
    );
    try {
      const created = await expiringApp.hono.fetch(
        new Request('http://test/api/keyrings', {
          method: 'POST',
          headers: headersFor(LAPTOP),
          body: JSON.stringify({}),
        }),
      );
      const ring = (await created.json()) as KeyringWire;
      const mint = await expiringApp.hono.fetch(
        new Request('http://test/api/keyrings/self/pairings', {
          method: 'POST',
          headers: headersFor(LAPTOP, { [KEYRING_HEADER]: ring.token }),
        }),
      );
      const { code } = (await mint.json()) as { code: string };

      const res = await expiringApp.hono.fetch(
        new Request('http://test/api/pairings/redeem', {
          method: 'POST',
          headers: headersFor(PHONE),
          body: JSON.stringify({ code }),
        }),
      );
      expect(res.status).toBe(404);
    } finally {
      await expiringApp.close();
    }
  });

  test('minting a code invalidates the previous one', async () => {
    const ring = await createKeyring(LAPTOP);
    const first = await mintPairing(ring.token);
    const second = await mintPairing(ring.token);

    expect(await redeem(first.code).then((r) => r.status)).toBe(404);
    expect(await redeem(second.code).then((r) => r.status)).toBe(200);
  });

  test('a document added on one device shows up on the other', async () => {
    const ring = await createKeyring(LAPTOP);
    const doc = await upload(LAPTOP, { markdown: '# Later', name: 'Later doc' });

    const put = await putDoc(ring.token, doc.uid, {
      invite_token: doc.admin_invite.token,
      title: 'Later doc',
    });
    expect(put.status).toBe(200);

    const pulled = await app.hono.fetch(
      new Request('http://test/api/keyrings/self', {
        headers: headersFor(PHONE, { [KEYRING_HEADER]: ring.token }),
      }),
    );
    expect(pulled.status).toBe(200);
    const body = (await pulled.json()) as KeyringWire;
    expect(body.docs.map((d) => d.doc_uid)).toEqual([doc.uid]);
    expect(body.docs[0]?.title).toBe('Later doc');
  });

  test('re-pushing a rotated admin token replaces the stale one', async () => {
    const doc = await upload(LAPTOP);
    const ring = await createKeyring(LAPTOP, [
      { doc_uid: doc.uid, invite_token: doc.admin_invite.token, title: 'Doc' },
    ]);

    const rotated = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/invites/admin/rotate`, {
        method: 'POST',
        headers: headersFor(LAPTOP, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(rotated.status).toBe(200);
    const fresh = (await rotated.json()) as { admin_invite: { token: string } };

    expect(
      await putDoc(ring.token, doc.uid, { invite_token: fresh.admin_invite.token }),
    ).toHaveProperty('status', 200);

    const pulled = await app.hono.fetch(
      new Request('http://test/api/keyrings/self', {
        headers: headersFor(PHONE, { [KEYRING_HEADER]: ring.token }),
      }),
    );
    const body = (await pulled.json()) as KeyringWire;
    expect(body.docs[0]?.invite_token).toBe(fresh.admin_invite.token);
    // A title already stored is kept when a push omits it.
    expect(body.docs[0]?.title).toBe('Doc');
  });

  test('a token that is not an invite on that document is refused', async () => {
    const docA = await upload(LAPTOP);
    const docB = await upload(LAPTOP);
    const ring = await createKeyring(LAPTOP);

    // Right shape, wrong document.
    const res = await putDoc(ring.token, docA.uid, {
      invite_token: docB.admin_invite.token,
    });
    expect(res.status).toBe(404);
  });

  test('a deleted document falls out of the keyring listing', async () => {
    const doc = await upload(LAPTOP);
    const ring = await createKeyring(LAPTOP, [
      { doc_uid: doc.uid, invite_token: doc.admin_invite.token },
    ]);

    const del = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}`, {
        method: 'DELETE',
        headers: headersFor(LAPTOP, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(del.status).toBe(204);

    const pulled = await app.hono.fetch(
      new Request('http://test/api/keyrings/self', {
        headers: headersFor(PHONE, { [KEYRING_HEADER]: ring.token }),
      }),
    );
    expect(((await pulled.json()) as KeyringWire).docs).toHaveLength(0);
  });

  test('a revoked invite keeps its row but reports no role', async () => {
    const doc = await upload(LAPTOP);
    const adminHeaders = headersFor(LAPTOP, { [INVITE_HEADER]: doc.admin_invite.token });
    const invite = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/invites`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ kind: 'generic', role: 'reader' }),
      }),
    );
    const { invite: made } = (await invite.json()) as { invite: { token: string } };

    const ring = await createKeyring(LAPTOP, [
      { doc_uid: doc.uid, invite_token: made.token, title: 'Doc' },
    ]);
    expect(ring.docs[0]?.role).toBe('reader');

    const revoked = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/invites/${made.token}`, {
        method: 'DELETE',
        headers: adminHeaders,
      }),
    );
    expect(revoked.status).toBe(204);

    const pulled = await app.hono.fetch(
      new Request('http://test/api/keyrings/self', {
        headers: headersFor(PHONE, { [KEYRING_HEADER]: ring.token }),
      }),
    );
    const body = (await pulled.json()) as KeyringWire;
    expect(body.docs).toHaveLength(1);
    expect(body.docs[0]?.role).toBeNull();
  });

  test('rotating the keyring carries the documents and kills the old token', async () => {
    const doc = await upload(LAPTOP);
    const ring = await createKeyring(LAPTOP, [
      { doc_uid: doc.uid, invite_token: doc.admin_invite.token },
    ]);
    const stale = await mintPairing(ring.token);

    const res = await app.hono.fetch(
      new Request('http://test/api/keyrings/self/rotate', {
        method: 'POST',
        headers: ringHeaders(LAPTOP, ring.token),
      }),
    );
    expect(res.status).toBe(200);
    const fresh = (await res.json()) as { token: string; client_id: string };
    expect(fresh.token).not.toBe(ring.token);
    expect(fresh.client_id).toBe(LAPTOP.id);

    const old = await app.hono.fetch(
      new Request('http://test/api/keyrings/self', {
        headers: headersFor(LAPTOP, { [KEYRING_HEADER]: ring.token }),
      }),
    );
    expect(old.status).toBe(404);

    // A code minted before the rotation must not survive it.
    expect(await redeem(stale.code).then((r) => r.status)).toBe(404);

    const pulled = await app.hono.fetch(
      new Request('http://test/api/keyrings/self', {
        headers: headersFor(LAPTOP, { [KEYRING_HEADER]: fresh.token }),
      }),
    );
    expect(((await pulled.json()) as KeyringWire).docs).toHaveLength(1);
  });

  test('deleting the keyring takes its documents and its codes with it', async () => {
    const doc = await upload(LAPTOP);
    const ring = await createKeyring(LAPTOP, [
      { doc_uid: doc.uid, invite_token: doc.admin_invite.token },
    ]);
    const { code } = await mintPairing(ring.token);

    const res = await app.hono.fetch(
      new Request('http://test/api/keyrings/self', {
        method: 'DELETE',
        headers: ringHeaders(LAPTOP, ring.token),
      }),
    );
    expect(res.status).toBe(204);

    const pulled = await app.hono.fetch(
      new Request('http://test/api/keyrings/self', {
        headers: headersFor(PHONE, { [KEYRING_HEADER]: ring.token }),
      }),
    );
    expect(pulled.status).toBe(404);
    expect(await redeem(code).then((r) => r.status)).toBe(404);

    // The point of the endpoint: the copies of the invite tokens are
    // gone, not merely unreachable.
    expect(countFor(app, 'keyring_docs', ring.token)).toBe(0);
    expect(countFor(app, 'keyring_pairings', ring.token)).toBe(0);
  });

  test('deleting the keyring revokes nothing — the documents still open', async () => {
    const doc = await upload(LAPTOP);
    const ring = await createKeyring(LAPTOP, [
      { doc_uid: doc.uid, invite_token: doc.admin_invite.token },
    ]);

    await app.hono.fetch(
      new Request('http://test/api/keyrings/self', {
        method: 'DELETE',
        headers: ringHeaders(LAPTOP, ring.token),
      }),
    );

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}`, {
        headers: headersFor(LAPTOP, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe('admin');
  });

  test('deleting an unknown keyring is a 404', async () => {
    const res = await app.hono.fetch(
      new Request('http://test/api/keyrings/self', {
        method: 'DELETE',
        headers: headersFor(LAPTOP, { [KEYRING_HEADER]: 'nope' }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test('renaming through the keyring is what reaches the other devices', async () => {
    const ring = await createKeyring(LAPTOP);
    const res = await app.hono.fetch(
      new Request('http://test/api/keyrings/self', {
        method: 'PATCH',
        headers: ringHeaders(LAPTOP, ring.token),
        body: JSON.stringify({ display_name: 'Paul W' }),
      }),
    );
    expect(res.status).toBe(200);

    const pulled = await app.hono.fetch(
      new Request('http://test/api/keyrings/self', {
        headers: headersFor(PHONE, { [KEYRING_HEADER]: ring.token }),
      }),
    );
    expect(((await pulled.json()) as KeyringWire).display_name).toBe('Paul W');
  });

  test('an unknown keyring token is a 404, not an empty ring', async () => {
    const res = await app.hono.fetch(
      new Request('http://test/api/keyrings/self', {
        headers: headersFor(LAPTOP, { [KEYRING_HEADER]: 'nope' }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test('pairing codes avoid the characters people misread', () => {
    for (let i = 0; i < 200; i++) {
      const code = newPairingCode();
      expect(code).toMatch(
        /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/,
      );
    }
  });

  describe('idle expiry', () => {
    const DAY = 24 * 60 * 60 * 1000;

    /** A server that considers a ring abandoned after 30 days. */
    async function agingApp(): Promise<App> {
      return createApp(
        loadConfig({
          dataDir: mkdtempSync(join(tmpdir(), 'mdn-keyring-age-')),
          port: 0,
          webDir,
          keyringIdleTtlMs: 30 * DAY,
        }),
      );
    }

    function ageBy(target: App, token: string, ms: number): void {
      target.db
        .prepare('UPDATE keyrings SET updated_at = ? WHERE token = ?')
        .run(Date.now() - ms, token);
    }

    /** Mint a ring on `target`, which is also what runs the sweep. */
    async function ringOn(target: App, client: typeof LAPTOP): Promise<string> {
      const res = await target.hono.fetch(
        new Request('http://test/api/keyrings', {
          method: 'POST',
          headers: headersFor(client),
          body: JSON.stringify({}),
        }),
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as KeyringWire).token;
    }

    async function pull(target: App, token: string): Promise<number> {
      const res = await target.hono.fetch(
        new Request('http://test/api/keyrings/self', {
          headers: headersFor(LAPTOP, { [KEYRING_HEADER]: token }),
        }),
      );
      return res.status;
    }

    test('a ring nobody has touched in months goes when the next one is created', async () => {
      const aging = await agingApp();
      try {
        const abandoned = await ringOn(aging, LAPTOP);
        const mint = await aging.hono.fetch(
          new Request('http://test/api/keyrings/self/pairings', {
            method: 'POST',
            headers: headersFor(LAPTOP, { [KEYRING_HEADER]: abandoned }),
          }),
        );
        expect(mint.status).toBe(201);
        ageBy(aging, abandoned, 40 * DAY);

        const fresh = await ringOn(aging, PHONE);

        expect(await pull(aging, abandoned)).toBe(404);
        expect(countFor(aging, 'keyring_pairings', abandoned)).toBe(0);
        // Only the idle one — a sweep that took the live ring with it
        // would be the failure mode that matters.
        expect(await pull(aging, fresh)).toBe(200);
      } finally {
        await aging.close();
      }
    });

    test('a pull reports the window, so the client need not hardcode it', async () => {
      const aging = await agingApp();
      try {
        const token = await ringOn(aging, LAPTOP);
        const res = await aging.hono.fetch(
          new Request('http://test/api/keyrings/self', {
            headers: headersFor(LAPTOP, { [KEYRING_HEADER]: token }),
          }),
        );
        expect(res.status).toBe(200);
        expect(((await res.json()) as { idle_ttl_ms: number }).idle_ttl_ms).toBe(30 * DAY);
      } finally {
        await aging.close();
      }
    });

    test('pulling the ring is enough to keep it', async () => {
      const aging = await agingApp();
      try {
        const ring = await ringOn(aging, LAPTOP);
        ageBy(aging, ring, 40 * DAY);

        // A device that only reads still counts as a device.
        expect(await pull(aging, ring)).toBe(200);
        await ringOn(aging, PHONE);

        expect(await pull(aging, ring)).toBe(200);
      } finally {
        await aging.close();
      }
    });
  });

  describe('rate limiting', () => {
    /**
     * Trust the proxy header so each simulated attacker gets its own
     * bucket — without it every request in the test process shares the
     * 'unknown' key and the per-client limit is untestable.
     */
    async function limitedApp(over: Record<string, number> = {}): Promise<App> {
      return createApp(
        loadConfig({
          dataDir: mkdtempSync(join(tmpdir(), 'mdn-keyring-rl-')),
          port: 0,
          webDir,
          trustedProxyHops: 1,
          pairingRedeemPerClient: 3,
          pairingRedeemGlobal: 100,
          pairingRedeemWindowMs: 60_000,
          ...over,
        }),
      );
    }

    async function redeemFrom(target: App, code: string, ip: string): Promise<Response> {
      return target.hono.fetch(
        new Request('http://test/api/pairings/redeem', {
          method: 'POST',
          headers: headersFor(PHONE, { 'x-forwarded-for': ip }),
          body: JSON.stringify({ code }),
        }),
      );
    }

    test('wrong codes from one client are cut off, with a Retry-After', async () => {
      const limited = await limitedApp();
      try {
        for (let i = 0; i < 3; i++) {
          expect(await redeemFrom(limited, 'ZZZZ-ZZZZ', '203.0.113.7').then((r) => r.status)).toBe(
            404,
          );
        }
        const blocked = await redeemFrom(limited, 'ZZZZ-ZZZZ', '203.0.113.7');
        expect(blocked.status).toBe(429);
        expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
        expect((await blocked.json()) as { error: string }).toMatchObject({
          error: 'too-many-attempts',
        });
      } finally {
        await limited.close();
      }
    });

    test('one client burning its budget does not lock out another', async () => {
      const limited = await limitedApp();
      try {
        for (let i = 0; i < 4; i++) await redeemFrom(limited, 'ZZZZ-ZZZZ', '203.0.113.7');
        expect(await redeemFrom(limited, 'ZZZZ-ZZZZ', '198.51.100.4').then((r) => r.status)).toBe(
          404,
        );
      } finally {
        await limited.close();
      }
    });

    test('a malformed body is still an attempt — it must not be a free probe', async () => {
      const limited = await limitedApp();
      try {
        for (let i = 0; i < 3; i++) {
          const res = await limited.hono.fetch(
            new Request('http://test/api/pairings/redeem', {
              method: 'POST',
              headers: headersFor(PHONE, { 'x-forwarded-for': '203.0.113.9' }),
              body: 'not json',
            }),
          );
          expect(res.status).toBe(400);
        }
        expect(await redeemFrom(limited, 'ZZZZ-ZZZZ', '203.0.113.9').then((r) => r.status)).toBe(
          429,
        );
      } finally {
        await limited.close();
      }
    });

    test('the global cap holds even when every attempt claims a new address', async () => {
      // The attacker-controlled case: rotate the source address each try,
      // so the per-client counter never fires and only the global one can
      // stop it.
      const limited = await limitedApp({ pairingRedeemGlobal: 5 });
      try {
        for (let i = 0; i < 5; i++) {
          expect(
            await redeemFrom(limited, 'ZZZZ-ZZZZ', `203.0.113.${i}`).then((r) => r.status),
          ).toBe(404);
        }
        expect(await redeemFrom(limited, 'ZZZZ-ZZZZ', '198.51.100.1').then((r) => r.status)).toBe(
          429,
        );
      } finally {
        await limited.close();
      }
    });

    test('a successful pairing costs nothing, so real use is never throttled', async () => {
      const limited = await limitedApp({ pairingRedeemPerClient: 2, pairingRedeemGlobal: 2 });
      try {
        const created = await limited.hono.fetch(
          new Request('http://test/api/keyrings', {
            method: 'POST',
            headers: headersFor(LAPTOP),
            body: JSON.stringify({}),
          }),
        );
        const ring = (await created.json()) as KeyringWire;

        // Pair repeatedly — more times than the failure budget allows.
        for (let i = 0; i < 4; i++) {
          const mint = await limited.hono.fetch(
            new Request('http://test/api/keyrings/self/pairings', {
              method: 'POST',
              headers: headersFor(LAPTOP, { [KEYRING_HEADER]: ring.token }),
            }),
          );
          const { code } = (await mint.json()) as { code: string };
          expect(await redeemFrom(limited, code, '203.0.113.7').then((r) => r.status)).toBe(200);
        }
      } finally {
        await limited.close();
      }
    });

    test('keyring creation is capped per client', async () => {
      const limited = await limitedApp({
        keyringCreatePerClient: 2,
        keyringCreateWindowMs: 60_000,
      });
      try {
        const create = async (): Promise<number> => {
          const res = await limited.hono.fetch(
            new Request('http://test/api/keyrings', {
              method: 'POST',
              headers: headersFor(LAPTOP, { 'x-forwarded-for': '203.0.113.7' }),
              body: JSON.stringify({}),
            }),
          );
          return res.status;
        };
        expect(await create()).toBe(201);
        expect(await create()).toBe(201);
        expect(await create()).toBe(429);
      } finally {
        await limited.close();
      }
    });
  });

  test('normalizePairingCode rejects anything that is not a code', () => {
    expect(normalizePairingCode('ABCD-EFGH')).toBe('ABCD-EFGH');
    expect(normalizePairingCode(' abcd efgh ')).toBe('ABCD-EFGH');
    expect(normalizePairingCode('ABCD-EFG')).toBeNull();
    expect(normalizePairingCode('ABCD-EFGI')).toBeNull(); // I is not in the alphabet
    expect(normalizePairingCode('')).toBeNull();
  });
});
