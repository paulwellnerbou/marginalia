import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, Container, Text } from '@radix-ui/themes';
import {
  getDocument,
  authenticate,
  ApiError,
  type Document,
  type DocumentSettingsResponse,
} from '../lib/api.js';
import { DocumentLayout } from '../components/DocumentLayout.js';
import { PasswordPrompt } from '../components/PasswordPrompt.js';
import { documentTitle } from '../lib/doc-title.js';
import { reportError } from '../lib/log.js';
import { recordVisit } from '../lib/recent-docs.js';
import { AppBar } from '../components/AppBar.js';
import { loadInviteToken, saveInviteToken } from '../lib/invite.js';

export function ViewPage() {
  const { uid, token } = useParams<{ uid: string; token?: string }>();
  const [doc, setDoc] = useState<Document | null>(null);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        if (err instanceof ApiError && err.status === 401) setPasswordRequired(true);
        else if (err instanceof ApiError && err.status === 404) setError('Document not found');
        else setError('Failed to load document');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uid, token]);

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

  useEffect(() => {
    if (!doc) return;
    const previous = document.title;
    document.title = `${documentTitle(doc)} · Marginalia`;
    return () => {
      document.title = previous;
    };
  }, [doc]);

  async function handlePassword(password: string) {
    if (!uid) return;
    await authenticate(uid, password);
    setPasswordRequired(false);
    const d = await getDocument(uid);
    setDoc(d);
  }

  function handleSettingsChanged(s: DocumentSettingsResponse) {
    if (!doc) return;
    setDoc({
      ...doc,
      editable_by_anyone: s.editable_by_anyone,
      default_theme: s.default_theme,
      password_protected: s.password_protected,
    });
  }

  if (error) {
    return (
      <>
        <AppBar />
        <Container size="2" py="8">
          <Text as="p" color="red">{error}</Text>
          <Link to="/">← Home</Link>
        </Container>
      </>
    );
  }
  if (passwordRequired) {
    return (
      <>
        <AppBar />
        <PasswordPrompt onSubmit={handlePassword} />
      </>
    );
  }
  if (!doc) {
    return (
      <>
        <AppBar />
        <Container size="2" py="8">
          <Text color="gray">Loading…</Text>
        </Container>
      </>
    );
  }

  return (
    <DocumentLayout doc={doc} onDocSettingsChanged={handleSettingsChanged}>
      {(doc.role === 'admin' || doc.role === 'editor' || doc.editable_by_anyone) && (
        <Button variant="soft" asChild>
          <Link to={`/d/${doc.uid}/edit`}>Edit</Link>
        </Button>
      )}
    </DocumentLayout>
  );
}
