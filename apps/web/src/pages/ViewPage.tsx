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
  // Bumped by the error "Try again" button to re-trigger getDocument.
  const [reloadNonce, setReloadNonce] = useState(0);

  // Persist the URL-supplied invite token before loading the doc so the API
  // client picks it up on the first GET.
  useEffect(() => {
    if (uid && token) saveInviteToken(uid, token);
  }, [uid, token]);

  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    // Reset per-load state so a lingering error from the previous uid
    // doesn't force the error UI over the incoming doc. React Router
    // reuses this component across /d/:uid route changes.
    setError(null);
    setDoc(null);
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
          // Only reaches here if the user dismissed the password dialog.
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
      format: doc.format,
      visited_at: Date.now(),
      updated_at: doc.updated_at,
      ...(stored ? { invite_token: stored } : {}),
    });
  }, [doc]);

  // Sync localStorage to the server's authoritative name so the header
  // we send matches what the server has, and renames only fire when the
  // user edits via UserMenu. Trade-off: opening someone else's named
  // invite overwrites the global local name.
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
      name: s.name,
      default_theme: s.default_theme,
      mermaid_renderer: s.mermaid_renderer,
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
              <Button variant="soft" onClick={() => setReloadNonce((n) => n + 1)}>
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
