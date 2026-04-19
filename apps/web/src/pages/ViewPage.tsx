import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, Container, Flex, Text } from '@radix-ui/themes';
import {
  getDocument,
  ApiError,
  type Document,
  type DocumentSettingsResponse,
} from '../lib/api.js';
import { DocumentLayout } from '../components/DocumentLayout.js';
import { PasswordPromptDialog } from '../components/PasswordPromptDialog.js';
import { documentTitle } from '../lib/doc-title.js';
import { reportError } from '../lib/log.js';
import { recordVisit } from '../lib/recent-docs.js';
import { AppBar } from '../components/AppBar.js';
import { loadInviteToken, saveInviteToken } from '../lib/invite.js';
import { getDisplayName, setDisplayName } from '../lib/identity.js';

export function ViewPage() {
  const { uid, token } = useParams<{ uid: string; token?: string }>();
  const [doc, setDoc] = useState<Document | null>(null);
  const [error, setError] = useState<string | null>(null);
  // When a 401/password-required surfaces (initial load or mid-session),
  // api.ts stalls the request and dispatches an event; PasswordPromptDialog
  // handles the UI. The one we need to care about here is RETRYING the
  // initial load after the user authenticates — handled by `reloadNonce`.
  const [reloadNonce, setReloadNonce] = useState(0);

  // Persist the URL-supplied invite token before loading the doc so the API
  // client picks it up on the first GET.
  useEffect(() => {
    if (uid && token) saveInviteToken(uid, token);
  }, [uid, token]);

  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    (async () => {
      try {
        const d = await getDocument(uid);
        if (!cancelled) setDoc(d);
      } catch (err) {
        if (cancelled) return;
        reportError('ViewPage.load', err, { uid });
        if (err instanceof ApiError && err.status === 404) {
          setError('Document not found');
        } else if (err instanceof ApiError && err.status === 401) {
          // The centralized auth-gate only rejects here if the user
          // dismissed the password dialog. Treat it as a soft error with
          // a retry affordance.
          setError('Password required to open this document');
        } else {
          setError('Failed to load document');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uid, token, reloadNonce]);

  useEffect(() => {
    if (!doc) return;
    const stored = loadInviteToken(doc.uid);
    recordVisit({
      uid: doc.uid,
      title: documentTitle(doc),
      role: doc.role,
      password_protected: doc.password_protected,
      visited_at: Date.now(),
      updated_at: doc.updated_at,
      ...(stored ? { invite_token: stored } : {}),
    });
  }, [doc]);

  // ACCESS_CONTROL option 1: named/admin invites seed localStorage. The
  // server returns the authoritative current name in `doc.display_name`
  // (either the invite's seed on first visit or the possibly-renamed
  // doc_users row on subsequent visits). Syncing localStorage to that
  // keeps the header we send on future requests in lockstep with what
  // the server already has on file, so renames only fire when the user
  // intentionally edits via UserMenu.
  //
  // Consequence: opening someone else's named invite URL on a browser
  // with a pre-existing local name will overwrite that local name with
  // the invite's. That's the trade-off of a single global localStorage
  // identity — acceptable per spec ("saved in their localstorage").
  useEffect(() => {
    if (!doc?.display_name) return;
    if (getDisplayName() !== doc.display_name) {
      setDisplayName(doc.display_name);
    }
  }, [doc]);

  useEffect(() => {
    if (!doc) return;
    const previous = document.title;
    document.title = `${documentTitle(doc)} · Marginalia`;
    return () => {
      document.title = previous;
    };
  }, [doc]);

  function handleSettingsChanged(s: DocumentSettingsResponse) {
    if (!doc) return;
    setDoc({
      ...doc,
      default_theme: s.default_theme,
      password_protected: s.password_protected,
    });
  }

  if (error) {
    return (
      <>
        <AppBar />
        {uid && <PasswordPromptDialog docUid={uid} />}
        <Container size="2" py="8">
          <Text as="p" color="red">{error}</Text>
          <Flex gap="3" mt="3">
            <Link to="/">← Home</Link>
            {uid && (
              <Button
                variant="soft"
                onClick={() => {
                  setError(null);
                  setReloadNonce((n) => n + 1);
                }}
              >
                Try again
              </Button>
            )}
          </Flex>
        </Container>
      </>
    );
  }
  if (!doc) {
    return (
      <>
        <AppBar />
        {uid && <PasswordPromptDialog docUid={uid} />}
        <Container size="2" py="8">
          <Text color="gray">Loading…</Text>
        </Container>
      </>
    );
  }

  return (
    <>
      <PasswordPromptDialog docUid={doc.uid} />
      <DocumentLayout doc={doc} onDocSettingsChanged={handleSettingsChanged}>
        {(doc.role === 'admin' || doc.role === 'editor') && (
          <Button variant="soft" asChild>
            <Link to={`/d/${doc.uid}/edit`}>Edit</Link>
          </Button>
        )}
      </DocumentLayout>
    </>
  );
}
