import ReactMarkdown from 'react-markdown';
import {
  ChatBubbleIcon,
  FileTextIcon,
  GitHubLogoIcon,
  MagicWandIcon,
  PaperPlaneIcon,
  PlusIcon,
  UploadIcon,
} from '../icons.js';
import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Code,
  Container,
  Divider as Separator,
  Flex,
  Modal,
  SimpleGrid,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppBar } from '../components/AppBar.js';
import { Copyable } from '../components/Copyable.js';
import { RecentDocumentCard } from '../components/RecentDocumentCard.js';
import {
  ApiError,
  type DocumentBundle,
  type DocumentFormat,
  importDocumentBundle,
  isDocumentFormat,
  uploadDocument,
} from '../lib/api.js';
import { deriveDisplayName, getClientId, getDisplayName, setDisplayName } from '../lib/identity.js';
import { saveInviteToken } from '../lib/invite.js';
import { reportError } from '../lib/log.js';
import {
  consumePendingNewDocumentDraft,
  type PendingNewDocumentDraft,
} from '../lib/new-document-draft.js';
import {
  type RecentDoc,
  loadRecentDocs,
  openUrlFor,
  recordVisit,
  removeFromRecent,
} from '../lib/recent-docs.js';

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

  function refreshRecent() {
    setRecent(loadRecentDocs());
  }

  useEffect(() => {
    const pendingDraft = consumePendingNewDocumentDraft();
    if (!pendingDraft) return;
    setUploadDraft(pendingDraft);
    setUploadOpen(true);
  }, []);

  function openFreshUploadDialog() {
    setUploadDraft(null);
    setUploadOpen(true);
  }

  function handleUploadOpenChange(nextOpen: boolean) {
    setUploadOpen(nextOpen);
    if (!nextOpen) setUploadDraft(null);
  }

  return (
    <>
      <AppBar />

      <div className="landing">
        {/* HERO */}
        <section className="landing-hero">
          <Container size={880} px="4" className="landing-hero-shell">
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="landing-github-link"
            >
              <GitHubLogoIcon className="landing-github-icon" />
              <span>View on GitHub</span>
            </a>
            <Flex direction="column" align="center" gap="5" py="9" className="landing-hero-inner">
              <Badge variant="light" size="sm" className="landing-eyebrow">
                <MagicWandIcon /> Markdown, set in type
              </Badge>
              <Text component="h1" className="landing-title" ta="center">
                Collaborate beautifully.
                <br />
                <span className="landing-title-sub">Full-featured Markdown documents.</span>
              </Text>
              <Text size="xl" c="dimmed" ta="center" style={{ maxWidth: '52ch' }}>
                Marginalia renders your Markdown or AsciiDoc with book-quality typography, tracks every save in
                git, and lets collaborators leave comments and change proposals on any paragraph.
              </Text>
              <Flex gap="3" mt="2" wrap="wrap" justify="center">
                <Button size="lg" onClick={openFreshUploadDialog}>
                  <PlusIcon />
                  New document
                </Button>
                {recent.length > 0 && (
                  <Button size="lg" variant="light" component="a" href="#recent">
                    Your documents
                  </Button>
                )}
              </Flex>
            </Flex>
          </Container>
        </section>

        {/* FEATURE STRIP */}
        <section className="landing-features">
          <Container size={1120} px="4" pb="7">
            <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="4">
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
                title="Local-first identities"
                body="People are managed in browser and by invite links. No online accounts, no sign-ups, and no external profile store. Share invite links and collaborate anonymously."
              />
            </SimpleGrid>
          </Container>
        </section>
        {/* RECENT DOCS */}
        <section className="landing-recent" id="recent">
          <Container size={1120} px="4" py="7">
            <Flex justify="between" align="end" mb="4" wrap="wrap" gap="3">
              <Box>
                <Text component="h2" size="lg" fw={600}>Your documents</Text>
                <Text size="sm" c="dimmed" component="p" mt="1">
                  Everything you've opened on this browser. Click to re-open with the same role.
                </Text>
              </Box>
              {recent.length > 0 && (
                <Button variant="light" onClick={openFreshUploadDialog}>
                  <PlusIcon /> New document
                </Button>
              )}
            </Flex>

            {recent.length === 0 ? (
              <EmptyState onCreate={openFreshUploadDialog} />
            ) : (
              <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="3">
                {recent.map((r) => (
                  <RecentDocumentCard
                    key={r.uid}
                    doc={r}
                    onOpen={() => navigate(openUrlFor(r))}
                    onRemove={() => {
                      removeFromRecent(r.uid);
                      refreshRecent();
                    }}
                  />
                ))}
              </SimpleGrid>
            )}
          </Container>
        </section>

        <LandingFooter />
      </div>

      <UploadDialog
        open={uploadOpen}
        onOpenChange={handleUploadOpenChange}
        draft={uploadDraft}
        onUploaded={(d) => {
          const { token, ...recent } = d;
          recordVisit(recent);
          refreshRecent();
          navigate(token ? `/d/${d.uid}/${token}` : `/d/${d.uid}`);
        }}
      />
    </>
  );
}

const IMPRINT_MD = import.meta.env.VITE_IMPRINT_MD as string | undefined;

function LandingFooter() {
  const [dialog, setDialog] = useState<'imprint' | 'privacy' | 'terms' | null>(null);

  return (
    <footer className="landing-footer">
      <Container size={1120} px="4" py="2">
        <Flex
          justify="between"
          align={{ initial: 'start', sm: 'center' }}
          gap="3"
          wrap="wrap"
          className="landing-footer-row"
        >
          <Text size="xs" c="dimmed">
            Marginalia is local-first and does not use analytics or tracking.
          </Text>
          <Flex gap="3" wrap="wrap" className="landing-footer-links">
            <button type="button" className="landing-footer-link" onClick={() => setDialog('imprint')}>
              <span>Imprint</span>
            </button>
            <button type="button" className="landing-footer-link" onClick={() => setDialog('privacy')}>
              <span>Privacy</span>
            </button>
            <button type="button" className="landing-footer-link" onClick={() => setDialog('terms')}>
              <span>Terms of Service</span>
            </button>
          </Flex>
        </Flex>
      </Container>
      <Modal
        opened={dialog !== null}
        onClose={() => setDialog(null)}
        size={dialog === 'imprint' ? '620px' : '680px'}
        title={(
          <Text fw={600} size="lg">
            {dialog === 'imprint'
              ? 'Imprint'
              : dialog === 'privacy'
                ? 'Privacy'
                : 'Terms of Service'}
          </Text>
        )}
      >
        {dialog === 'imprint' ? (
          <Box className="imprint-md">
            {IMPRINT_MD ? (
              <ReactMarkdown>{IMPRINT_MD}</ReactMarkdown>
            ) : (
              <Flex direction="column" gap="3">
                <Text component="p" size="sm">
                  This instance is self-hosted software. The responsible operator is the
                  person or organization running this installation.
                </Text>
                <Text component="p" size="sm" c="dimmed">
                  Set <Code>VITE_IMPRINT_MD</Code> at build time to show operator details
                  here. The value is rendered as Markdown.
                </Text>
              </Flex>
            )}
          </Box>
        ) : dialog === 'privacy' ? (
          <>
            <Text size="sm" c="dimmed" mb="4">
              Short privacy notice for this app.
            </Text>
            <Flex direction="column" gap="3">
              <Text component="p" size="sm">
                We do not use third-party analytics, ad trackers, or behavioral profiling.
              </Text>
              <Text component="p" size="sm">
                We do not require online user accounts. Display names and recent-document
                entries are stored in your browser so collaboration remains local-first.
              </Text>
              <Text component="p" size="sm">
                The only data processed on the server is what collaboration needs: document
                content, comment threads, invite roles, and optional document passwords when
                enabled.
              </Text>
              <Text component="p" size="sm">
                Data is retained until removed by an administrator of the corresponding
                document or by the operator of this deployment.
              </Text>
            </Flex>
          </>
        ) : (
          <>
            <Text size="sm" c="dimmed" mb="4">
              Basic terms for using this collaboration app.
            </Text>
            <Flex direction="column" gap="3">
              <Text component="p" size="sm">
                Use this service only for lawful content and lawful collaboration.
              </Text>
              <Text component="p" size="sm">
                Invite links are access capabilities. Keep them private and share them only
                with people who should access the document.
              </Text>
              <Text component="p" size="sm">
                The service is provided without guaranteed uptime, permanence, or fitness for a
                particular purpose unless separately agreed by the operator.
              </Text>
              <Text component="p" size="sm">
                You are responsible for the content you upload and for respecting the rights
                and privacy of collaborators.
              </Text>
            </Flex>
          </>
        )}
      </Modal>
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
    <Card p="3" className="feature-card">
      <Flex direction="column" gap="3">
        <Flex
          align="center"
          justify="center"
          className={`feature-icon${iconVariant ? ` feature-icon--${iconVariant}` : ''}`}
        >
          {icon}
        </Flex>
        <Text component="h3" size="md" fw={500}>
          {title}
        </Text>
        <Text size="sm" c="dimmed">
          {body}
        </Text>
      </Flex>
    </Card>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <Card p="3" className="landing-empty">
      <Flex direction="column" align="center" gap="3" py="5">
        <FileTextIcon width="28" height="28" />
        <Text component="h3" size="md" fw={600}>No documents yet</Text>
        <Text size="sm" c="dimmed" ta="center" style={{ maxWidth: '40ch' }}>
          Paste some Markdown and you'll get a shareable URL with beautiful typography in one click.
        </Text>
        <Button size="md" onClick={onCreate} mt="2">
          <PlusIcon />
          Create your first document
        </Button>
      </Flex>
    </Card>
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
  const [source, setSource] = useState(SAMPLE);
  // Format is inferred from the dropped/selected file's extension. Pastes
  // default to markdown. The server enforces a `source` + `format` pair,
  // so whatever is in state is what gets sent.
  const [format, setFormat] = useState<DocumentFormat>('markdown');
  /**
   * `docName` is the DOCUMENT's name (what to call the file). Empty →
   * auto-derive from the source's title / first heading at display time.
   * Entirely unrelated to the user's own display name (which lives in the
   * app bar UserMenu and is required for commits/comments).
   */
  const [docName, setDocName] = useState('');
  const [passwordProtected, setPasswordProtected] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdPassword, setCreatedPassword] = useState<string | null>(null);
  const [createdAdminUrl, setCreatedAdminUrl] = useState<string | null>(null);
  const [createdUid, setCreatedUid] = useState<string | null>(null);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [createdTitle, setCreatedTitle] = useState<string>('Untitled');
  // Snapshot of the created doc's format, taken at upload/import time so
  // `openCreated()` writes the correct value into recent-docs even for
  // paths where the dialog's `format` state is stale (e.g. JSON bundle
  // import doesn't touch `format` — the bundle itself carries it).
  const [createdFormat, setCreatedFormat] = useState<DocumentFormat>('markdown');
  const jsonInputRef = useRef<HTMLInputElement>(null);

  // If the user already set a display name globally we use it silently.
  // Otherwise this dialog offers an inline field to set one right here —
  // no need to send them off to find another control.
  const [userDisplayName, setUserDisplayNameState] = useState<string | null>(() =>
    getDisplayName(),
  );
  // `deriveDisplayName` only recognises markdown heading syntax; for
  // AsciiDoc we fall back to the first non-empty line stripped of its
  // leading `= ` if present — good enough for the common case of a doc
  // with a title line.
  const derivedTitle =
    format === 'asciidoc' ? deriveAsciidocTitle(source) : deriveDisplayName(source);
  const effectiveDocName = docName.trim() || derivedTitle;

  useEffect(() => {
    if (!open || !draft || createdAdminUrl) return;
    reset(draft);
  }, [createdAdminUrl, draft, open]);

  async function handleFile(file: File) {
    if (isBundleFile(file)) {
      await importBundleFile(file);
      return;
    }
    const text = await file.text();
    setSource(text);
    setFormat(formatFromFilename(file.name));
  }

  function loadIdentityForSubmit() {
    const user = (userDisplayName ?? '').trim();
    if (!user) {
      setError(
        'Please set your display name first. It is the name shown on your edits and comments.',
      );
      return null;
    }
    setDisplayName(user);
    return { clientId: getClientId(), displayName: user.slice(0, 80) };
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

      setCreatedUid(res.uid);
      setCreatedToken(res.admin_invite.token);
      setCreatedAdminUrl(adminUrl);
      setCreatedPassword(null);
      setCreatedTitle(res.name ?? bundle.document?.name ?? 'Untitled');
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
      };
      if (docName.trim()) uploadOpts.name = docName.trim();
      const res = await uploadDocument(uploadOpts, identity);
      saveInviteToken(res.uid, res.admin_invite.token);
      const adminUrl = window.location.origin + res.admin_invite.url;

      setCreatedUid(res.uid);
      setCreatedToken(res.admin_invite.token);
      setCreatedAdminUrl(adminUrl);
      setCreatedTitle((res.name ?? effectiveDocName) || 'Untitled');
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
    setSource(nextDraft?.source ?? SAMPLE);
    setFormat(nextDraft?.format ?? 'markdown');
    setDocName(nextDraft?.docName ?? '');
    setPasswordProtected(false);
    setSubmitting(false);
    setError(null);
    setCreatedPassword(null);
    setCreatedAdminUrl(null);
    setCreatedUid(null);
    setCreatedToken(null);
    setCreatedTitle('Untitled');
    setCreatedFormat(nextDraft?.format ?? 'markdown');
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
    <Modal
      opened={open}
      onClose={() => {
        onOpenChange(false);
        reset();
      }}
      size="860px"
      title={(
        <Text fw={600} size="lg">
          {createdAdminUrl && createdUid && createdToken ? 'Document ready' : 'New document'}
        </Text>
      )}
    >
        {createdAdminUrl && createdUid && createdToken ? (
          <>
            <Text size="sm" c="dimmed" mb="4">
              Bookmark the admin link below — it's the only way back into this document with full
              control.
            </Text>
            <Flex direction="column" gap="3" mb="4">
              <Flex
                direction={{ initial: 'column', sm: 'row' }}
                align={{ initial: 'stretch', sm: 'end' }}
                gap="3"
              >
                <Box className="created-admin-link">
                  <Text component="div" size="xs" c="dimmed" mb="1">
                    Admin link
                  </Text>
                  <Copyable text={createdAdminUrl} multiline ariaLabel="Copy admin link" />
                </Box>
                <Button onClick={openCreated}>Open the document</Button>
              </Flex>
              {createdPassword && (
                <Box>
                  <Text component="div" size="xs" c="dimmed" mb="1">
                    Password (shown once)
                  </Text>
                  <Copyable text={createdPassword} ariaLabel="Copy password" />
                </Box>
              )}
            </Flex>
          </>
        ) : (
          <form onSubmit={submit}>
            <Text size="sm" c="dimmed" mb="4">
              Paste Markdown, upload a <Code>.md</Code> file, or import a previously exported
              <Code>.json</Code> bundle. It gets its own URL.
            </Text>

            <Flex direction="column" gap="3">
              {!getDisplayName() && (
                <Box className="callout-soft">
                  <Text size="sm" c="dimmed" component="p" mb="2">
                    Please set your display name first. It is the name shown on your edits and
                    comments.
                  </Text>
                  <TextInput
                    size="sm"
                    value={userDisplayName ?? ''}
                    onChange={(e: any) => setUserDisplayNameState(e.target.value)}
                    placeholder="Your display name (e.g. Alex Cho)"
                    maxLength={80}
                    autoFocus
                  />
                </Box>
              )}

              <Box>
                <Text component="label" size="sm" htmlFor="doc-name">
                  Document name
                  <Text component="span" size="xs" c="dimmed">
                    {' '}
                    (optional
                    {docName.trim() ? '' : derivedTitle ? ` — will use “${derivedTitle}”` : ''})
                  </Text>
                </Text>
                <TextInput
                  id="doc-name"
                  value={docName}
                  onChange={(e: any) => setDocName(e.target.value)}
                  placeholder="Leave blank to use the document's title"
                  maxLength={200}
                  mt="1"
                  autoFocus={!!getDisplayName()}
                />
              </Box>

              <Box>
                <Text component="label" size="sm" htmlFor="markdown-source">
                  {format === 'asciidoc' ? 'AsciiDoc source' : 'Markdown source'}
                </Text>
                <MarkdownDropZone onFile={handleFile}>
                  <Textarea
                    id="markdown-source"
                    value={source}
                    onChange={(e: any) => setSource(e.target.value)}
                    rows={14}
                    spellCheck={false}
                    className="markdown-textarea"
                    mt="1"
                  />
                </MarkdownDropZone>
              </Box>

              <FileDropZone
                accept=".md,.markdown,.mdx,.adoc,.asciidoc,.json,text/markdown,application/json"
                onFile={handleFile}
                label="Drop a Markdown, AsciiDoc, or JSON bundle file — or click to browse"
              />

              <Flex align="center" gap="2">
                <input
                  ref={jsonInputRef}
                  type="file"
                  accept=".json,application/json"
                  style={{ display: 'none' }}
                  onChange={(e: any) => {
                    const f = e.target.files?.[0];
                    if (f) void importBundleFile(f);
                    e.currentTarget.value = '';
                  }}
                />
                <Button
                  type="button"
                  variant="light"
                  onClick={() => jsonInputRef.current?.click()}
                  disabled={submitting || !userDisplayName}
                >
                  <UploadIcon />
                  Import JSON bundle
                </Button>
                <Text size="sm" c="dimmed">
                  Restores source, comments, and renderer metadata from an exported bundle.
                </Text>
              </Flex>

              <Separator />

              <Flex direction="column" gap="2">
                <Text component="label" size="sm">
                  <Flex align="center" gap="2">
                    <Checkbox
                      checked={passwordProtected}
                      onChange={(event) => setPasswordProtected(event.currentTarget.checked)}
                    />
                    Password-protect (server generates a password, shown once)
                  </Flex>
                </Text>
                {/* Editing rights are granted via invite links in Access
                    control; no upload-time toggle. */}
              </Flex>

              {error && (
                <Alert color="red" variant="light">
                  {error}
                </Alert>
              )}

              <Flex justify="end" gap="2">
                <Button
                  variant="light"
                  color="gray"
                  onClick={() => {
                    reset();
                    onOpenChange(false);
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting || !source || !userDisplayName}>
                  {submitting ? 'Uploading…' : 'Create document'}
                </Button>
              </Flex>
            </Flex>
          </form>
        )}
    </Modal>
  );
}

/**
 * Extension/MIME check shared by the two drop zones. The browser's
 * `accept` attribute only gates the native file picker — it doesn't
 * help with drag-and-drop, where any file the user drops reaches the
 * onDrop handler. Keep the filter in one place so MarkdownDropZone
 * (wrapping the textarea) and FileDropZone (the visible panel) can't
 * drift and end up accepting different file types.
 */
function isAcceptedUploadFile(file: File): boolean {
  if (file.type === 'text/markdown') return true;
  const n = file.name.toLowerCase();
  return (
    n.endsWith('.md') ||
    n.endsWith('.markdown') ||
    n.endsWith('.mdx') ||
    n.endsWith('.adoc') ||
    n.endsWith('.asciidoc') ||
    n.endsWith('.json')
  );
}

/**
 * Wraps a child with drag/drop handlers that accept a markdown file or a
 * previously exported JSON bundle and call `onFile` with it. Shows a subtle overlay while a file is
 * being dragged over. Children are untouched by the drop (the drop just
 * fires onFile, doesn't mess with the child's own state).
 */
function MarkdownDropZone({
  children,
  onFile,
}: {
  children: React.ReactNode;
  onFile: (file: File) => void | Promise<void>;
}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  return (
    <div
      className={`drop-zone ${over ? 'drop-zone--over' : ''}`}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          depth.current += 1;
          setOver(true);
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDragLeave={() => {
        depth.current -= 1;
        if (depth.current <= 0) {
          depth.current = 0;
          setOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file && isAcceptedUploadFile(file)) void onFile(file);
      }}
    >
      {children}
      {over && (
        <div className="drop-zone-overlay">
          <Text size="md" fw={500}>
            Drop Markdown, AsciiDoc, or a JSON bundle to load it
          </Text>
        </div>
      )}
    </div>
  );
}

/**
 * Visible pick-or-drop zone: clicking opens the native file picker via a
 * hidden `<input>`; dragging a file over it shows an `--over` state and
 * forwards the drop to `onFile`. Renders as a discoverable dashed
 * panel rather than the browser-default "Choose file" button — same
 * accept list as the textarea dropzone so both paths load the same file
 * types.
 */
function FileDropZone({
  accept,
  onFile,
  label,
}: {
  accept: string;
  onFile: (file: File) => void | Promise<void>;
  label: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  function openPicker() {
    inputRef.current?.click();
  }

  return (
    <div
      className={`file-drop ${over ? 'file-drop--over' : ''}`}
      role="button"
      tabIndex={0}
      onClick={openPicker}
      onKeyDown={(e: any) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openPicker();
        }
      }}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        depth.current -= 1;
        if (depth.current <= 0) {
          depth.current = 0;
          setOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        const file = e.dataTransfer.files?.[0];
        // `accept=` on the hidden input gates the OS picker, but
        // drag-and-drop bypasses it entirely. Apply the same filter
        // MarkdownDropZone uses so binary / unsupported files don't
        // reach onFile.
        if (file && isAcceptedUploadFile(file)) void onFile(file);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        style={{ display: 'none' }}
        onChange={(e: any) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
          // Reset so re-selecting the same file still fires onChange.
          e.currentTarget.value = '';
        }}
      />
      <UploadIcon width="18" height="18" />
      <Text size="sm">{label}</Text>
    </div>
  );
}

function isBundleFile(file: File): boolean {
  return file.type === 'application/json' || file.name.toLowerCase().endsWith('.json');
}

function formatFromFilename(name: string): DocumentFormat {
  const n = name.toLowerCase();
  if (n.endsWith('.adoc') || n.endsWith('.asciidoc')) return 'asciidoc';
  return 'markdown';
}

/**
 * Pull a plausible title out of AsciiDoc source. Preference order:
 *   1. The document title line `= Title` (attribute-entry style)
 *   2. The first non-blank, non-attribute line
 *
 * Matches `deriveDisplayName`'s role for markdown: a client-side fallback
 * when the user leaves the name field blank at upload time. The server
 * later derives its own title from the rendered frontmatter.
 */
function deriveAsciidocTitle(source: string): string {
  const lines = source.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const titleMatch = /^=\s+(.+)$/.exec(line);
    if (titleMatch) return titleMatch[1]!.trim();
    if (line.startsWith(':') || line.startsWith('//')) continue;
    return line.slice(0, 80);
  }
  return '';
}
