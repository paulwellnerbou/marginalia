import {
  ChatBubbleIcon,
  Cross2Icon,
  DownloadIcon,
  FileTextIcon,
  LockClosedIcon,
  MagicWandIcon,
  PaperPlaneIcon,
  PlusIcon,
  UploadIcon,
} from '@radix-ui/react-icons';
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Checkbox,
  Code,
  Container,
  Dialog,
  Flex,
  Grid,
  Heading,
  IconButton,
  Separator,
  Text,
  Tooltip,
} from '@radix-ui/themes';
import { Fragment, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Link, useNavigate } from 'react-router-dom';
import { AppBar } from '../components/AppBar.js';
import { CopyAccessLinkButton } from '../components/CopyAccessLinkButton.js';
import { Copyable } from '../components/Copyable.js';
import { DeviceSyncPanel } from '../components/DeviceSyncPanel.js';
import { FormatBadge } from '../components/FormatBadge.js';
import {
  DISPLAY_NAME_REQUIRED,
  NewDocumentFields,
  useNewDocumentFields,
} from '../components/NewDocumentFields.js';
import { OpenByLink } from '../components/OpenByLink.js';
import { PasswordDisclosureCard } from '../components/PasswordDisclosureCard.js';
import {
  ApiError,
  coverProxyUrl,
  type DocumentBundle,
  type DocumentFormat,
  importDocumentBundle,
  isDocumentFormat,
  uploadDocument,
} from '../lib/api.js';
import { formatTimestampLong } from '../lib/format-time.js';
import { saveInviteToken } from '../lib/invite.js';
import {
  pushDoc as keyringPushDoc,
  removeDoc as keyringRemoveDoc,
  pullKeyring,
} from '../lib/keyring.js';
import { reportError } from '../lib/log.js';
import {
  consumePendingNewDocumentDraft,
  type PendingNewDocumentDraft,
} from '../lib/new-document-draft.js';
import { closeTab } from '../lib/open-tabs.js';
import {
  groupRecentDocs,
  loadRecentDocs,
  openUrlFor,
  type RecentDoc,
  recordVisit,
  removeFromRecent,
} from '../lib/recent-docs.js';
import { appRoleColor } from '../styles/theme.js';

const SAMPLE = `# Welcome

This is a markdown document. Edit me, then save.

## Features

- Tables, images, mermaid diagrams, syntax-highlighted code
- In-document references that work with Unicode headings
- Threaded comments you can resolve

\`\`\`ts
console.log('hello');
\`\`\`
`;

const GITHUB_REPO_URL = 'https://github.com/paulwellnerbou/marginalia';

export function HomePage() {
  const navigate = useNavigate();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadDraft, setUploadDraft] = useState<PendingNewDocumentDraft | null>(null);
  const [recent, setRecent] = useState<RecentDoc[]>(() => loadRecentDocs());
  // Syncing switched itself off because the ring behind it is gone. Held
  // here rather than in the panel because only the pull knows it, and the
  // panel has already flipped to its disconnected face by then.
  const [keyringDropped, setKeyringDropped] = useState(false);
  const [keyringIdleTtlMs, setKeyringIdleTtlMs] = useState<number | null>(null);

  function refreshRecent() {
    setRecent(loadRecentDocs());
  }

  useEffect(() => {
    const pendingDraft = consumePendingNewDocumentDraft();
    if (!pendingDraft) return;
    setUploadDraft(pendingDraft);
    setUploadOpen(true);
  }, []);

  // Render the local list first, then reconcile. The cards are readable
  // straight from localStorage, so waiting on the network before showing
  // anything would trade a working offline list for a spinner.
  useEffect(() => {
    let cancelled = false;
    void pullKeyring().then((pull) => {
      if (cancelled) return;
      if (pull.docs) setRecent(pull.docs);
      if (pull.dropped) setKeyringDropped(true);
      if (pull.idleTtlMs !== null) setKeyringIdleTtlMs(pull.idleTtlMs);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function openFreshUploadDialog() {
    setUploadDraft(null);
    setUploadOpen(true);
  }

  function handleUploadOpenChange(nextOpen: boolean) {
    setUploadOpen(nextOpen);
    if (!nextOpen) setUploadDraft(null);
  }

  const hasDocs = recent.length > 0;

  const hero = (
    <section className="landing-hero" key="hero">
      <Container size="3" px="4" className="landing-hero-shell">
        <a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer" className="landing-github-link">
          <GitHubMark />
          <span>View on GitHub</span>
        </a>
        <Flex direction="column" align="center" gap="5" py="9" className="landing-hero-inner">
          <Badge variant="soft" size="2" className="landing-eyebrow">
            <MagicWandIcon /> Markdown, set in type
          </Badge>
          <Heading size="9" align="center" className="landing-title">
            Collaborate beautifully.
            <br />
            <span className="landing-title-sub">Full-featured Markdown documents.</span>
          </Heading>
          <Text size="5" color="gray" align="center" style={{ maxWidth: '52ch' }}>
            Marginalia renders your Markdown or AsciiDoc with book-quality typography, tracks every
            save in git, and lets collaborators leave comments and change proposals on any
            paragraph.
          </Text>
          <Flex gap="3" mt="2" wrap="wrap" justify="center">
            <Button size="4" onClick={openFreshUploadDialog}>
              <PlusIcon />
              New document
            </Button>
          </Flex>
        </Flex>
      </Container>
    </section>
  );

  const features = (
    <section className="landing-features" key="features">
      <Container size="4" px="4" pb="7">
        {/* Two up from `xs`: `sm` is 768px, which an iPad mini in portrait
            (744px) misses by a hair — one column there wastes half the width. */}
        <Grid columns={{ initial: '1', xs: '2', md: '4' }} gap="4">
          <FeatureCard
            icon={<FileTextIcon width="20" height="20" />}
            title="Properly typeset"
            body="Built-in themes — Book, Document, Article, Technical, and more — all reading the same semantic HTML. Switch with one click."
          />
          <FeatureCard
            icon={<ChatBubbleIcon width="20" height="20" />}
            iconVariant="ruby"
            title="Conversations that stick"
            body="Highlight a paragraph, comment and reply in a thread. Propose changes. Document history is tracked."
          />
          <FeatureCard
            icon={<PaperPlaneIcon width="20" height="20" />}
            iconVariant="gray"
            title="No account required"
            body="Open an invite link, choose a display name, and start collaborating. Access stays in your browser—no sign-up or external profile store."
          />
          <FeatureCard
            icon={<DownloadIcon width="20" height="20" />}
            title="One document, many formats"
            body="Download as source, styled PDF, Word, or EPUB. Comments and proposed changes can travel with the Word document."
          />
        </Grid>
      </Container>
    </section>
  );

  // Ways *into* a document: they open the section for someone with an empty
  // list, and step aside for the cards once there is a list to read.
  const docTools = (
    <Fragment key="tools">
      <Box mb="4">
        <DeviceSyncPanel
          dropped={keyringDropped}
          onDismissDropped={() => setKeyringDropped(false)}
          idleTtlMs={keyringIdleTtlMs}
          onSynced={() => {
            setKeyringDropped(false);
            void pullKeyring().then((pull) => {
              if (pull.docs) setRecent(pull.docs);
              if (pull.idleTtlMs !== null) setKeyringIdleTtlMs(pull.idleTtlMs);
            });
          }}
        />
      </Box>

      <Box mb={hasDocs ? '0' : '5'} className="open-by-link">
        <OpenByLink />
      </Box>
    </Fragment>
  );

  const docList = hasDocs ? (
    <Grid key="list" columns={{ initial: '1', xs: '2', md: '3' }} gap="3" mb="5">
      {groupRecentDocs(recent).map(({ doc: r, companions }) => (
        <RecentCard
          key={r.uid}
          doc={r}
          companions={companions}
          onRemove={() => {
            removeFromRecent(r.uid);
            // A document dropped from the list can't stay in the tab
            // strip: reopening it from there would only put it back.
            closeTab(r.uid);
            keyringRemoveDoc(r.uid);
            refreshRecent();
          }}
        />
      ))}
    </Grid>
  ) : (
    <EmptyState key="list" onCreate={openFreshUploadDialog} />
  );

  const documents = (
    <section className="landing-recent" id="recent" key="documents">
      <Container size="4" px="4" py="7">
        <Flex justify="between" align="end" mb="4" wrap="wrap" gap="3">
          <Box>
            <Heading size="6">Your documents</Heading>
            <Text size="2" color="gray" as="p" mt="1">
              Everything you've opened on this browser. Click to re-open with the same role.
            </Text>
          </Box>
          {hasDocs && (
            <Button variant="soft" onClick={openFreshUploadDialog}>
              <PlusIcon /> New document
            </Button>
          )}
        </Flex>

        {hasDocs ? [docList, docTools] : [docTools, docList]}
      </Container>
    </section>
  );

  return (
    <>
      <AppBar />

      <div className={`landing${hasDocs ? ' landing--docs-after-hero' : ''}`}>
        {/* Someone who already has documents gets them right under the hero,
            ahead of the pitch. Swapping in the DOM rather than with CSS `order`
            keeps focus and screen-reader order matching the screen; the stable
            keys let React move the sections instead of remounting a live
            pairing session when a keyring pull populates an empty list. */}
        {hasDocs ? [hero, documents, features] : [hero, features, documents]}

        <LandingFooter />
      </div>

      <UploadDialog
        open={uploadOpen}
        onOpenChange={handleUploadOpenChange}
        draft={uploadDraft}
        onUploaded={(d) => {
          const { token, ...recent } = d;
          recordVisit(recent);
          if (token) keyringPushDoc(d.uid, token, recent.title);
          refreshRecent();
          navigate(token ? `/d/${d.uid}/${token}` : `/d/${d.uid}`);
        }}
      />
    </>
  );
}

function GitHubMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="landing-github-icon">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
        0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
        -.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66
        .07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15
        -.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09
        2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82
        2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01
        2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

// Only a .env file expands `\n`; a Docker build-arg delivers it literally.
const IMPRINT_MD = (import.meta.env.VITE_IMPRINT_MD as string | undefined)?.replace(/\\n/g, '\n');

function LandingFooter() {
  return (
    <footer className="landing-footer">
      <Container size="4" px="4" py="2">
        <Flex
          justify="between"
          align={{ initial: 'start', sm: 'center' }}
          gap="3"
          wrap="wrap"
          className="landing-footer-row"
        >
          <Text size="1" color="gray">
            Marginalia stores auth state in your browser and document data on the server. No
            analytics or tracking.
          </Text>
          <Flex gap="3" wrap="wrap" className="landing-footer-links">
            <Dialog.Root>
              <Dialog.Trigger className="landing-footer-link">
                <span>Imprint</span>
              </Dialog.Trigger>
              <Dialog.Content maxWidth="620px">
                <Dialog.Title>Imprint</Dialog.Title>
                <Box className="imprint-md">
                  {IMPRINT_MD ? (
                    <ReactMarkdown>{IMPRINT_MD}</ReactMarkdown>
                  ) : (
                    <Flex direction="column" gap="3">
                      <Text as="p" size="2">
                        This instance is self-hosted software. The responsible operator is the
                        person or organization running this installation.
                      </Text>
                      <Text as="p" size="2" color="gray">
                        Set <Code>VITE_IMPRINT_MD</Code> at build time to show operator details
                        here. The value is rendered as Markdown.
                      </Text>
                    </Flex>
                  )}
                </Box>
              </Dialog.Content>
            </Dialog.Root>

            <Dialog.Root>
              <Dialog.Trigger className="landing-footer-link">
                <span>Privacy</span>
              </Dialog.Trigger>
              <Dialog.Content maxWidth="680px">
                <Dialog.Title>Privacy</Dialog.Title>
                <Dialog.Description size="2" color="gray" mb="4">
                  Short privacy notice for this app.
                </Dialog.Description>
                <Flex direction="column" gap="3">
                  <Text as="p" size="2">
                    We do not use third-party analytics, ad trackers, or behavioral profiling.
                  </Text>
                  <Text as="p" size="2">
                    We do not require online user accounts. This browser stores invite tokens,
                    display names, recent-document entries, and password-session cookies.
                  </Text>
                  <Text as="p" size="2">
                    The server stores the collaboration data: document content, comment threads,
                    history, invite roles, and optional document password hashes when enabled.
                  </Text>
                  <Text as="p" size="2">
                    Data is retained until removed by an administrator of the corresponding document
                    or by the operator of this deployment.
                  </Text>
                </Flex>
              </Dialog.Content>
            </Dialog.Root>

            <Dialog.Root>
              <Dialog.Trigger className="landing-footer-link">
                <span>Terms of Service</span>
              </Dialog.Trigger>
              <Dialog.Content maxWidth="680px">
                <Dialog.Title>Terms of Service</Dialog.Title>
                <Dialog.Description size="2" color="gray" mb="4">
                  Basic terms for using this collaboration app.
                </Dialog.Description>
                <Flex direction="column" gap="3">
                  <Text as="p" size="2">
                    Use this service only for lawful content and lawful collaboration.
                  </Text>
                  <Text as="p" size="2">
                    Invite links are access capabilities. Keep them private and share them only with
                    people who should access the document.
                  </Text>
                  <Text as="p" size="2">
                    The service is provided without guaranteed uptime, permanence, or fitness for a
                    particular purpose unless separately agreed by the operator.
                  </Text>
                  <Text as="p" size="2">
                    You are responsible for the content you upload and for respecting the rights and
                    privacy of collaborators.
                  </Text>
                </Flex>
              </Dialog.Content>
            </Dialog.Root>
          </Flex>
        </Flex>
      </Container>
    </footer>
  );
}

function FeatureCard({
  icon,
  iconVariant,
  title,
  body,
}: {
  icon: React.ReactNode;
  /** Optional color accent for the icon tile. Default = theme accent. */
  iconVariant?: 'ruby' | 'gray';
  title: string;
  body: string;
}) {
  return (
    <Card size="3" className="feature-card">
      <Flex direction="column" gap="3">
        <Flex
          align="center"
          justify="center"
          className={`feature-icon${iconVariant ? ` feature-icon--${iconVariant}` : ''}`}
        >
          {icon}
        </Flex>
        <Heading size="4" weight="medium">
          {title}
        </Heading>
        <Text size="2" color="gray">
          {body}
        </Text>
      </Flex>
    </Card>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <Card size="3" className="landing-empty">
      <Flex direction="column" align="center" gap="3" py="5">
        <FileTextIcon width="28" height="28" />
        <Heading size="4">No documents yet</Heading>
        <Text size="2" color="gray" align="center" style={{ maxWidth: '44ch' }}>
          Paste some Markdown and you'll get a shareable URL with beautiful typography in one click.
          Already been invited to one? Open it with its link above.
        </Text>
        <Button
          size={{ initial: '2', xs: '3' }}
          onClick={onCreate}
          mt="2"
          className="landing-empty-cta"
        >
          <PlusIcon />
          Create your first document
        </Button>
      </Flex>
    </Card>
  );
}

function RecentCard({
  doc,
  companions,
  onRemove,
}: {
  doc: RecentDoc;
  /** Documents that belong with this one, listed here instead of as cards. */
  companions: RecentDoc[];
  onRemove: () => void;
}) {
  const updatedSinceVisit = doc.updated_at > doc.visited_at;
  const url = openUrlFor(doc);
  return (
    <Card size="2" className="recent-card">
      {/* Real <a> overlay so the URL appears in the browser's status
          bar on hover and middle/cmd-click open in a new tab. The
          IconButton sits above this overlay via CSS z-index. */}
      <Link to={url} className="recent-card-link" aria-label={`Open ${doc.title}`} />
      <Flex gap="3" align="start">
        {doc.cover && <RecentCardCover doc={doc} />}
        <Box className="recent-card-body">
          <Text className="recent-card-uid" size="1" color="gray" mb="1" as="div">
            {doc.uid}
          </Text>
          <Flex justify="between" align="start" gap="2">
            <Heading size="3" weight="medium" truncate className="recent-card-title">
              {doc.title}
            </Heading>
            <Flex align="center" gap="1">
              {doc.invite_token && (
                <CopyAccessLinkButton
                  uid={doc.uid}
                  token={doc.invite_token}
                  role={doc.role}
                  className="recent-card-action"
                />
              )}
              <Tooltip content="Remove from recent">
                <IconButton
                  variant="ghost"
                  size="1"
                  color="gray"
                  aria-label="Remove from recent"
                  className="recent-card-action"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onRemove();
                  }}
                >
                  <Cross2Icon />
                </IconButton>
              </Tooltip>
            </Flex>
          </Flex>
          <Flex gap="2" mt="2" wrap="wrap" align="center">
            <FormatBadge format={doc.format} />
            <Badge variant="soft" color={appRoleColor(doc.role)} size="1" className="role-badge">
              {doc.role}
            </Badge>
            {doc.password_protected && (
              <Badge color="amber" variant="soft" size="1">
                <LockClosedIcon />
              </Badge>
            )}
            {updatedSinceVisit && (
              <Badge color="green" variant="soft" size="1">
                New since last visit
              </Badge>
            )}
          </Flex>
          {companions.length > 0 && (
            <ul
              className="recent-card-companions"
              aria-label={`Documents that belong with ${doc.title}`}
            >
              {companions.map((c) => (
                <li key={c.uid}>
                  <Link to={openUrlFor(c)} className="recent-card-companion">
                    <FileTextIcon aria-hidden />
                    {c.title}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Text size="1" color="gray" mt="3" as="div" title={formatTimestampLong(doc.visited_at)}>
            Last opened {formatRelative(doc.visited_at)}
          </Text>
        </Box>
      </Flex>
    </Card>
  );
}

/**
 * Book-cover thumbnail. The recorded cover can be stale — removed since
 * the last visit, or behind a password session that has since expired —
 * and the asset proxy answers 404/401 for both, so a failed load drops
 * the image rather than leaving a broken-image glyph on the card.
 */
function RecentCardCover({ doc }: { doc: RecentDoc }) {
  const [failed, setFailed] = useState(false);
  if (!doc.cover || failed) return null;
  return (
    <img
      className="cover-thumb recent-card-cover"
      src={coverProxyUrl(doc.uid, doc.cover)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

// --- UploadDialog ---------------------------------------------------

function UploadDialog({
  open,
  onOpenChange,
  draft,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  draft: PendingNewDocumentDraft | null;
  onUploaded: (d: RecentDoc & { token?: string }) => void;
}) {
  const fields = useNewDocumentFields({ source: SAMPLE, format: 'markdown' });
  const { source, format, docName, effectiveDocName, userDisplayName } = fields;
  const [passwordProtected, setPasswordProtected] = useState(false);
  // Matches the server default. Unticking it is the deliberate act of
  // putting the document on the open web.
  const [inviteOnly, setInviteOnly] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdPassword, setCreatedPassword] = useState<string | null>(null);
  const [createdAdminUrl, setCreatedAdminUrl] = useState<string | null>(null);
  const [createdUid, setCreatedUid] = useState<string | null>(null);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [createdTitle, setCreatedTitle] = useState<string>('Untitled');
  const [createdDocName, setCreatedDocName] = useState<string | null>(null);
  // Set only when a bundle carried a history the server couldn't use.
  // Worth saying out loud on the way out: the import still succeeds, so
  // nothing else on this panel hints that the document just lost its
  // timeline, and the bundle is the only copy of it.
  const [historyDropped, setHistoryDropped] = useState(false);
  // Snapshot of the created doc's format, taken at upload/import time so
  // `openCreated()` writes the correct value into recent-docs even for
  // paths where the dialog's `format` state is stale (e.g. JSON bundle
  // import doesn't touch `format` — the bundle itself carries it).
  const [createdFormat, setCreatedFormat] = useState<DocumentFormat>('markdown');
  const jsonInputRef = useRef<HTMLInputElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is a render-local function declaration — adding it would re-fire on every render. Triggers below cover the only state changes that warrant a re-seed.
  useEffect(() => {
    if (!open || !draft || createdAdminUrl) return;
    reset(draft);
  }, [createdAdminUrl, draft, open]);

  function loadIdentityForSubmit() {
    const identity = fields.identityForSubmit();
    if (!identity) setError(DISPLAY_NAME_REQUIRED);
    return identity;
  }

  async function importBundleFile(file: File) {
    setError(null);
    const identity = loadIdentityForSubmit();
    if (!identity) return;

    setSubmitting(true);
    try {
      const raw = await file.text();
      const bundle = JSON.parse(raw) as DocumentBundle;
      const res = await importDocumentBundle(bundle, identity);
      saveInviteToken(res.uid, res.admin_invite.token);
      const adminUrl = window.location.origin + res.admin_invite.url;

      setHistoryDropped(res.imported_history === 'dropped');
      setCreatedUid(res.uid);
      setCreatedToken(res.admin_invite.token);
      setCreatedAdminUrl(adminUrl);
      setCreatedPassword(null);
      setCreatedTitle(res.name ?? bundle.document?.name ?? 'Untitled');
      setCreatedDocName(res.name ?? null);
      // The import response carries the server's format; fall back to
      // the bundle's own field when talking to older servers that don't
      // echo it back.
      setCreatedFormat(
        isDocumentFormat(res.format)
          ? res.format
          : isDocumentFormat(bundle.document?.format)
            ? bundle.document.format
            : 'markdown',
      );
    } catch (err) {
      reportError('Home.importBundle', err, { fileName: file.name });
      const reason =
        err instanceof ApiError
          ? `${err.code} (${err.status})`
          : err instanceof SyntaxError
            ? 'invalid JSON'
            : err instanceof Error
              ? err.message
              : 'unknown error';
      setError(`Could not import document: ${reason}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const identity = loadIdentityForSubmit();
    if (!identity) return;
    setSubmitting(true);
    try {
      const uploadOpts: Parameters<typeof uploadDocument>[0] = {
        source,
        format,
        password_protected: passwordProtected,
        invite_only: inviteOnly,
      };
      if (docName.trim()) uploadOpts.name = docName.trim();
      const res = await uploadDocument(uploadOpts, identity);
      saveInviteToken(res.uid, res.admin_invite.token);
      const adminUrl = window.location.origin + res.admin_invite.url;

      setHistoryDropped(false);
      setCreatedUid(res.uid);
      setCreatedToken(res.admin_invite.token);
      setCreatedAdminUrl(adminUrl);
      setCreatedTitle((res.name ?? effectiveDocName) || 'Untitled');
      setCreatedDocName(res.name ?? null);
      setCreatedFormat(res.format ?? format);
      if (res.password) setCreatedPassword(res.password);
    } catch (err) {
      reportError('Home.upload', err, { sourceLength: source.length, format });
      const reason =
        err instanceof ApiError
          ? `${err.code} (${err.status})`
          : err instanceof Error
            ? err.message
            : 'unknown error';
      setError(`Could not create document: ${reason}`);
    } finally {
      setSubmitting(false);
    }
  }

  function reset(nextDraft: PendingNewDocumentDraft | null = null) {
    fields.reset(nextDraft);
    setPasswordProtected(false);
    setInviteOnly(true);
    setSubmitting(false);
    setError(null);
    setCreatedPassword(null);
    setCreatedAdminUrl(null);
    setCreatedUid(null);
    setCreatedToken(null);
    setCreatedTitle('Untitled');
    setCreatedDocName(null);
    setCreatedFormat(nextDraft?.format ?? 'markdown');
    setHistoryDropped(false);
  }

  function openCreated() {
    if (!createdUid || !createdToken) return;
    onUploaded({
      uid: createdUid,
      token: createdToken,
      title: createdTitle,
      role: 'admin',
      password_protected: !!createdPassword,
      format: createdFormat,
      visited_at: Date.now(),
      updated_at: Date.now(),
    });
    reset();
    onOpenChange(false);
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <Dialog.Content maxWidth="860px" className="dialog-content--fixed-footer">
        {createdAdminUrl && createdUid && createdToken ? (
          <>
            <div className="dialog-scroll-body">
              <Dialog.Title>Document ready</Dialog.Title>
              <Dialog.Description size="2" color="gray" mb="4">
                Bookmark the admin link below — it's the only way back into this document with full
                control.
              </Dialog.Description>
              <Flex direction="column" gap="3">
                {historyDropped && (
                  <Callout.Root color="amber" size="1">
                    <Callout.Text>
                      The document imported, but its revision history could not be read from the
                      bundle and was left out — it starts from a single version. Keep the bundle
                      file: it still holds the original history.
                    </Callout.Text>
                  </Callout.Root>
                )}
                <Box className="created-admin-link">
                  <Text as="div" size="1" color="gray" mb="1">
                    Admin link
                  </Text>
                  <Copyable text={createdAdminUrl} multiline ariaLabel="Copy admin link" />
                </Box>
                {createdPassword && (
                  <PasswordDisclosureCard
                    docUid={createdUid}
                    password={createdPassword}
                    label="Password"
                    docName={createdDocName}
                  />
                )}
              </Flex>
            </div>
            <Flex className="dialog-footer" justify="end" mt="4">
              <Button onClick={openCreated}>Open the document</Button>
            </Flex>
          </>
        ) : (
          <form className="dialog-form-layout" onSubmit={submit}>
            <div className="dialog-scroll-body">
              <Dialog.Title>New document</Dialog.Title>
              <Dialog.Description size="2" color="gray" mb="4">
                Paste Markdown, upload a <Code>.md</Code> file, or import a previously exported
                <Code>.json</Code> bundle. It gets its own URL.
              </Dialog.Description>

              <Flex direction="column" gap="3">
                <NewDocumentFields fields={fields} onBundleFile={importBundleFile} />

                <Flex align="center" gap="2">
                  <input
                    ref={jsonInputRef}
                    type="file"
                    accept=".json,application/json"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void importBundleFile(f);
                      e.currentTarget.value = '';
                    }}
                  />
                  <Button
                    type="button"
                    variant="soft"
                    onClick={() => jsonInputRef.current?.click()}
                    disabled={submitting || !userDisplayName}
                  >
                    <UploadIcon />
                    Import JSON bundle
                  </Button>
                  <Text size="2" color="gray">
                    Restores source, comments, and renderer metadata from an exported bundle.
                  </Text>
                </Flex>

                <Separator size="4" />

                <Flex direction="column" gap="2">
                  <Text as="label" size="2">
                    <Flex align="center" gap="2">
                      <Checkbox
                        checked={passwordProtected}
                        onCheckedChange={(c) => setPasswordProtected(c === true)}
                      />
                      Password-protect (server generates a password, shown once)
                    </Flex>
                  </Text>
                  <Text as="label" size="2">
                    <Flex align="center" gap="2">
                      <Checkbox
                        checked={inviteOnly}
                        onCheckedChange={(c) => setInviteOnly(c === true)}
                      />
                      Restrict to access links
                    </Flex>
                  </Text>
                  <Flex pl="6">
                    <Text size="1" color="gray">
                      {/* The password is a gate of its own, so what the URL
                        alone is worth depends on both boxes. */}
                      {inviteOnly
                        ? 'Only people you hand an access link to can open it. The URL alone opens nothing.'
                        : passwordProtected
                          ? 'Anyone with the document URL can read it, once they enter the password.'
                          : 'Anyone with the document URL can read it.'}
                    </Text>
                  </Flex>
                  {/* Editing rights are granted via invite links in Access
                    control; no upload-time toggle. */}
                </Flex>

                {error && (
                  <Callout.Root color="red" size="1">
                    <Callout.Text>{error}</Callout.Text>
                  </Callout.Root>
                )}
              </Flex>
            </div>
            <Flex className="dialog-footer" justify="end" gap="2" mt="4">
              <Dialog.Close>
                <Button variant="soft" color="gray">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" disabled={submitting || !source || !userDisplayName}>
                {submitting ? 'Uploading…' : 'Create document'}
              </Button>
            </Flex>
          </form>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / (60 * 60_000))}h ago`;
  return new Date(ts).toLocaleDateString();
}
