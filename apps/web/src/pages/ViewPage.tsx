import { Button, Container, Flex, Text } from '@radix-ui/themes';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppBar } from '../components/AppBar.js';
import { DocumentLayout } from '../components/DocumentLayout.js';
import { NamePromptDialog } from '../components/NamePromptDialog.js';
import { PasswordPromptDialog } from '../components/PasswordPromptDialog.js';
import { ApiError, type Document, type DocumentSettingsResponse } from '../lib/api.js';
import { apiErrorMessage } from '../lib/apiErrorMessage.js';
import { documentTitle } from '../lib/doc-title.js';
import { showIdentityNotice } from '../lib/identity-notice.js';
import { loadInviteToken } from '../lib/invite.js';
import { type InviteLinkOutcome, linkRefusal, openInviteLink } from '../lib/invite-link.js';
import { adoptDocumentName, pushDoc as keyringPushDoc, scopeIdentityTo } from '../lib/keyring.js';
import { reportError } from '../lib/log.js';
import { openDocument } from '../lib/open-document.js';
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
  // Bumped by the error "Try again" button to re-trigger the load.
  const [reloadNonce, setReloadNonce] = useState(0);
  const [pending, setPending] = useState(false);
  // What opening the link in the address bar came to, for the load's error
  // message and the identity notice. Null when no link was opened.
  const linkOutcome = useRef<{ uid: string; outcome: Promise<InviteLinkOutcome> } | null>(null);

  // Ahead of every request below: each one carries the display name, and
  // the name is the one this person uses in the document's keyring.
  useEffect(() => {
    if (uid) scopeIdentityTo(uid);
  }, [uid]);

  // Claim the URL-supplied invite token (a session cookie, or for a group
  // link the personal link to keep), store the token the claim says to,
  // then strip it from the address bar so copy-pasting the URL no longer
  // leaks it. The invite row is kept server-side so the same user can
  // re-claim from another browser via the original URL. The load below
  // waits for the claim (see `getDocument`).
  useEffect(() => {
    if (!uid || !token) return;
    linkOutcome.current = { uid, outcome: openInviteLink(uid, token) };
    // Strip the token from the address bar synchronously so copy-pasting the
    // URL no longer leaks the bearer credential, even if the claim request is
    // still in flight or the component later re-renders for a different uid.
    // The query and fragment stay: a shared link carries `?view=full` and
    // `#comment-…` there, and both are read after this runs.
    window.history.replaceState(
      window.history.state,
      '',
      `/d/${uid}${window.location.search}${window.location.hash}`,
    );
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
        const d = await openDocument(uid);
        if (!cancelled) setDoc(d);
      } catch (err) {
        if (cancelled) return;
        reportError('ViewPage.load', err, { uid });
        const opened = linkOutcome.current?.uid === uid ? await linkOutcome.current.outcome : null;
        if (cancelled) return;
        const refusal = linkRefusal(opened);
        if (refusal && err instanceof ApiError && err.status === 401) {
          // The group link handed out nothing; say why rather than "not public".
          setError(
            apiErrorMessage(new ApiError(410, refusal), 'This link no longer opens the document'),
          );
          return;
        }
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
      ...(doc.folder && doc.folder.main_uid !== doc.uid ? { folder_uid: doc.folder.main_uid } : {}),
    });
    // After the visit is recorded, which is where ring membership lives.
    if (stored) keyringPushDoc(doc.uid, stored, documentTitle(doc));
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
  // invite overwrites the global local name, except in a synced browser.
  useEffect(() => {
    // Loading may have pulled the rings and learned which one holds it.
    if (doc) scopeIdentityTo(doc.uid);
    adoptDocumentName(doc?.display_name ?? null, {
      provisional: doc?.name_provisional === true,
      setAt: doc?.name_set_at ?? null,
    });
  }, [doc]);

  // Say who the visitor appears as: after opening a group link, and on
  // every visit while the name is still a placeholder.
  const noticedUid = useRef<string | null>(null);
  useEffect(() => {
    if (!doc || noticedUid.current === doc.uid) return;
    noticedUid.current = doc.uid;
    const opened = linkOutcome.current?.uid === doc.uid ? linkOutcome.current.outcome : null;
    void (async () => {
      const outcome = opened ? await opened : null;
      showIdentityNotice(doc, outcome);
    })();
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
        ...(s.default_accent !== undefined ? { default_accent: s.default_accent } : {}),
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
      <NamePromptDialog key={`name-${doc.uid}`} docUid={doc.uid} />
      {/* Keyed by uid so the arriving document mounts fresh, exactly as
          it did back when the shell was torn down between the two. */}
      <DocumentLayout
        key={`layout-${doc.uid}`}
        doc={doc}
        pending={pending}
        onDocSettingsChanged={handleSettingsChanged}
        {...(doc.role === 'admin' || doc.role === 'editor'
          ? { editHref: `/d/${doc.uid}/edit` }
          : {})}
      />
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
