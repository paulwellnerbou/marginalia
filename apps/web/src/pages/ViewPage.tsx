import { Button, Container, Flex, Text } from '@radix-ui/themes';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppBar } from '../components/AppBar.js';
import { DocumentLayout } from '../components/DocumentLayout.js';
import { PasswordPromptDialog } from '../components/PasswordPromptDialog.js';
import {
  ApiError,
  claimInvite,
  type Document,
  type DocumentSettingsResponse,
  getDocument,
} from '../lib/api.js';
import { apiErrorMessage } from '../lib/apiErrorMessage.js';
import { documentTitle } from '../lib/doc-title.js';
import { getDisplayName, setDisplayName } from '../lib/identity.js';
import { loadInviteToken, saveInviteToken } from '../lib/invite.js';
import { pushDoc as keyringPushDoc } from '../lib/keyring.js';
import { reportError } from '../lib/log.js';
import { openTab } from '../lib/open-tabs.js';
import { recordVisit } from '../lib/recent-docs.js';

/**
 * How long a document swap may take before it admits to being one. A
 * switch between tabs is usually well inside this, and a progress bar
 * that flashes for eighty milliseconds only makes the app look busier
 * than it is.
 */
const PENDING_GRACE_MS = 220;

export function ViewPage() {
  const { uid, token } = useParams<{ uid: string; token?: string }>();
  const [doc, setDoc] = useState<Document | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the error "Try again" button to re-trigger getDocument.
  const [reloadNonce, setReloadNonce] = useState(0);
  const [pending, setPending] = useState(false);

  // Persist the URL-supplied invite token, then claim it to mint a session
  // cookie, then strip the token from the address bar so copy-pasting the
  // URL no longer leaks it. The invite row is kept server-side so the same
  // user can re-claim from another browser via the original URL.
  useEffect(() => {
    if (!uid || !token) return;
    saveInviteToken(uid, token);
    // Strip the token from the address bar synchronously so copy-pasting the
    // URL no longer leaks the bearer credential, even if the claim request is
    // still in flight or the component later re-renders for a different uid.
    window.history.replaceState({}, '', `/d/${uid}`);
    claimInvite(uid, token).catch(() => {
      // 400 (admin invite), 409 (password-protected), 404 (invite gone):
      // fall back to invite-header auth via the token in localStorage.
    });
  }, [uid, token]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: token / reloadNonce are explicit refetch triggers — token swap drives re-auth and reloadNonce is bumped by the "Try again" button on the error screen to retry the load.
  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    // Reset the error so a lingering one from the previous uid doesn't
    // force the error UI over the incoming doc. React Router reuses this
    // component across /d/:uid route changes.
    //
    // The document itself is deliberately left on screen: blanking it
    // tears the whole three-pane shell down for as long as the fetch
    // takes, and the reader watches the page collapse and rebuild for
    // what is usually less than a tenth of a second. It stays until the
    // next one is ready to take its place in a single commit.
    setError(null);
    (async () => {
      try {
        const d = await getDocument(uid);
        if (!cancelled) setDoc(d);
      } catch (err) {
        if (cancelled) return;
        reportError('ViewPage.load', err, { uid });
        if (err instanceof ApiError && err.status === 404) {
          setError('Document not found');
        } else if (err instanceof ApiError && err.code === 'invite-required') {
          // No prompt to offer — the invite link is the only way in, and
          // it isn't something the visitor can type.
          setError(apiErrorMessage(err, 'This document is not open to the public'));
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
    // Opening a document from a link is also how it joins the keyring, so
    // a link someone sends you reaches your other devices by being used
    // once — no separate "add to my documents" step.
    if (stored) keyringPushDoc(doc.uid, stored, documentTitle(doc));
    recordVisit({
      uid: doc.uid,
      title: documentTitle(doc),
      role: doc.role,
      password_protected: doc.password_protected,
      format: doc.format,
      visited_at: Date.now(),
      updated_at: doc.updated_at,
      ...(stored ? { invite_token: stored } : {}),
      ...(doc.cover ? { cover: doc.cover } : {}),
    });
    openTab({
      uid: doc.uid,
      title: documentTitle(doc),
      format: doc.format,
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

  // What is on screen belongs to the tab being left until the next
  // document lands. Announced only once the wait is long enough to
  // wonder about.
  const loading = !!uid && !!doc && doc.uid !== uid;
  useEffect(() => {
    if (!loading) {
      setPending(false);
      return;
    }
    const timer = window.setTimeout(() => setPending(true), PENDING_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [loading]);

  useEffect(() => {
    if (!doc) return;
    const previous = document.title;
    document.title = `${documentTitle(doc)} · Marginalia`;
    return () => {
      document.title = previous;
    };
  }, [doc]);

  function handleSettingsChanged(changedUid: string, s: Partial<DocumentSettingsResponse>) {
    setDoc((current) => {
      if (!current || current.uid !== changedUid) return current;
      return {
        ...current,
        ...(s.name !== undefined ? { name: s.name } : {}),
        ...(s.default_theme !== undefined ? { default_theme: s.default_theme } : {}),
        ...(s.mermaid_renderer !== undefined ? { mermaid_renderer: s.mermaid_renderer } : {}),
        ...(s.password_protected !== undefined ? { password_protected: s.password_protected } : {}),
        ...(s.invite_only !== undefined ? { invite_only: s.invite_only } : {}),
      };
    });
  }

  if (error) {
    return (
      <>
        <AppBar />
        {uid && <PasswordPromptDialog docUid={uid} />}
        <Container size="2" py="8">
          <Text as="p" color="red">
            {error}
          </Text>
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
  // Nothing to hold on to yet — a cold load, not a tab switch.
  if (!doc) return <DocumentLoading {...(uid ? { uid } : {})} />;

  return (
    <>
      {/* Remounted per document: the saved-password and admin-recovery
          state is read once, at mount, from the uid it was given. Keys
          are prefixed because these two are siblings and would otherwise
          collide whenever the URL and the loaded document agree. */}
      <PasswordPromptDialog
        key={`prompt-${uid}`}
        docUid={uid ?? doc.uid}
        {...(loading ? {} : { docName: doc.name })}
      />
      {/* Keyed by uid so the arriving document mounts fresh, exactly as
          it did back when the shell was torn down between the two. */}
      <DocumentLayout
        key={`layout-${doc.uid}`}
        doc={doc}
        pending={pending}
        onDocSettingsChanged={handleSettingsChanged}
      >
        {(doc.role === 'admin' || doc.role === 'editor') && (
          <Button variant="soft" asChild>
            <Link to={`/d/${doc.uid}/edit`}>Edit</Link>
          </Button>
        )}
      </DocumentLayout>
    </>
  );
}

/**
 * First paint of a document, before there is anything to show. Holds the
 * page shell — app bar, full-height body — so the real layout lands into
 * the same frame rather than pushing a short page out of the way.
 */
function DocumentLoading({ uid }: { uid?: string }) {
  return (
    <div className="doc-page">
      <AppBar />
      {uid && <PasswordPromptDialog docUid={uid} />}
      <div className="doc-loading">
        <Text size="2" color="gray">
          Loading…
        </Text>
      </div>
    </div>
  );
}
