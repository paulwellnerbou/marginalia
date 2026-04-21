import ReactMarkdown from 'react-markdown';
import {
  ChatBubbleIcon,
  Cross2Icon,
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
  TextArea,
  TextField,
  Tooltip,
} from '@radix-ui/themes';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppBar } from '../components/AppBar.js';
import { Copyable } from '../components/Copyable.js';
import { FormatBadge } from '../components/FormatBadge.js';
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

export function HomePage() {
  const navigate = useNavigate();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [recent, setRecent] = useState<RecentDoc[]>(() => loadRecentDocs());

  function refreshRecent() {
    setRecent(loadRecentDocs());
  }

  return (
    <>
      <AppBar />

      <div className="landing">
        {/* HERO */}
        <section className="landing-hero">
          <Container size="3" px="4">
            <Flex direction="column" align="center" gap="5" py="9" className="landing-hero-inner">
              <Badge color="indigo" variant="soft" size="2" className="landing-eyebrow">
                <MagicWandIcon /> Markdown, set in type
              </Badge>
              <Heading size="9" align="center" className="landing-title">
                Collaborate beautifully.
                <br />
                <span className="landing-title-sub">Full-featured Markdown documents.</span>
              </Heading>
              <Text size="5" color="gray" align="center" style={{ maxWidth: '52ch' }}>
                Marginalia renders your Markdown with book-quality typography, tracks every save in
                git, and lets collaborators leave comments and change proposals on any paragraph.
              </Text>
              <Flex gap="3" mt="2" wrap="wrap" justify="center">
                <Button size="4" onClick={() => setUploadOpen(true)}>
                  <PlusIcon />
                  New document
                </Button>
                {recent.length > 0 && (
                  <Button size="4" variant="soft" asChild>
                    <a href="#recent">Your documents</a>
                  </Button>
                )}
              </Flex>
            </Flex>
          </Container>
        </section>

        {/* FEATURE STRIP */}
        <section className="landing-features">
          <Container size="4" px="4" pb="7">
            <Grid columns={{ initial: '1', sm: '3' }} gap="4">
              <FeatureCard
                icon={<FileTextIcon width="20" height="20" />}
                title="Properly typeset"
                body="Seven built-in themes — Book, Document, Article, Technical, and more — all reading the same semantic HTML. Switch with one click."
              />
              <FeatureCard
                icon={<ChatBubbleIcon width="20" height="20" />}
                iconVariant="ruby"
                title="Conversations that stick"
                body="Highlight a paragraph and reply in a thread. Comments re-anchor themselves as the document evolves; orphans surface separately."
              />
              <FeatureCard
                icon={<PaperPlaneIcon width="20" height="20" />}
                iconVariant="teal"
                title="Local-first identities"
                body="People are managed in this browser. No online accounts, no sign-ups, and no external profile store. Share invite links and collaborate anonymously."
              />
            </Grid>
          </Container>
        </section>

        {/* RECENT DOCS */}
        <section className="landing-recent" id="recent">
          <Container size="4" px="4" py="7">
            <Flex justify="between" align="end" mb="4" wrap="wrap" gap="3">
              <Box>
                <Heading size="6">Your documents</Heading>
                <Text size="2" color="gray" as="p" mt="1">
                  Everything you've opened on this browser. Click to re-open with the same role.
                </Text>
              </Box>
              {recent.length > 0 && (
                <Button variant="soft" onClick={() => setUploadOpen(true)}>
                  <PlusIcon /> New document
                </Button>
              )}
            </Flex>

            {recent.length === 0 ? (
              <EmptyState onCreate={() => setUploadOpen(true)} />
            ) : (
              <Grid columns={{ initial: '1', sm: '2', md: '3' }} gap="3">
                {recent.map((r) => (
                  <RecentCard
                    key={r.uid}
                    doc={r}
                    onOpen={() => navigate(openUrlFor(r))}
                    onRemove={() => {
                      removeFromRecent(r.uid);
                      refreshRecent();
                    }}
                  />
                ))}
              </Grid>
            )}
          </Container>
        </section>

        <LandingFooter />
      </div>

      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
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
            Marginalia is local-first and does not use analytics or tracking.
          </Text>
          <Flex gap="3" wrap="wrap" className="landing-footer-links">
            <Dialog.Root>
              <Dialog.Trigger className="landing-footer-link"><span>Imprint</span></Dialog.Trigger>
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
              <Dialog.Trigger className="landing-footer-link"><span>Privacy</span></Dialog.Trigger>
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
                    We do not require online user accounts. Display names and recent-document
                    entries are stored in your browser so collaboration remains local-first.
                  </Text>
                  <Text as="p" size="2">
                    The only data processed on the server is what collaboration needs: document
                    content, comment threads, invite roles, and optional document passwords when
                    enabled.
                  </Text>
                  <Text as="p" size="2">
                    Data is retained until removed by an administrator of the corresponding
                    document or by the operator of this deployment.
                  </Text>
                </Flex>
              </Dialog.Content>
            </Dialog.Root>

            <Dialog.Root>
              <Dialog.Trigger className="landing-footer-link"><span>Terms of Service</span></Dialog.Trigger>
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
                    Invite links are access capabilities. Keep them private and share them only
                    with people who should access the document.
                  </Text>
                  <Text as="p" size="2">
                    The service is provided without guaranteed uptime, permanence, or fitness for a
                    particular purpose unless separately agreed by the operator.
                  </Text>
                  <Text as="p" size="2">
                    You are responsible for the content you upload and for respecting the rights
                    and privacy of collaborators.
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
  /** Optional color accent for the icon tile. Default = theme accent (indigo). */
  iconVariant?: 'ruby' | 'teal';
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
        <Text size="2" color="gray" align="center" style={{ maxWidth: '40ch' }}>
          Paste some Markdown and you'll get a shareable URL with beautiful typography in one click.
        </Text>
        <Button size="3" onClick={onCreate} mt="2">
          <PlusIcon />
          Create your first document
        </Button>
      </Flex>
    </Card>
  );
}

function RecentCard({
  doc,
  onOpen,
  onRemove,
}: {
  doc: RecentDoc;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const updatedSinceVisit = doc.updated_at > doc.visited_at;
  return (
    <Card size="2" className="recent-card" onClick={onOpen}>
      <Flex justify="between" align="start" gap="2">
        <button type="button" onClick={onOpen} className="recent-card-title">
          <Heading size="3" weight="medium" truncate>
            {doc.title}
          </Heading>
        </button>
        <Tooltip content="Remove from recent">
          <IconButton
            variant="ghost"
            size="1"
            color="gray"
            aria-label="Remove from recent"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            <Cross2Icon />
          </IconButton>
        </Tooltip>
      </Flex>
      <Flex gap="2" mt="2" wrap="wrap" align="center">
        <FormatBadge format={doc.format} />
        <Badge
          variant="soft"
          color={doc.role === 'admin' ? 'indigo' : doc.role === 'editor' ? 'green' : 'gray'}
          size="1"
          className="role-badge"
        >
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
      <Text size="1" color="gray" mt="3" as="div" title={formatFullTs(doc.visited_at)}>
        Last opened {formatRelative(doc.visited_at)}
      </Text>
    </Card>
  );
}

// --- UploadDialog ---------------------------------------------------

function UploadDialog({
  open,
  onOpenChange,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
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

  function reset() {
    setSource(SAMPLE);
    setFormat('markdown');
    setDocName('');
    setPasswordProtected(false);
    setError(null);
    setCreatedPassword(null);
    setCreatedAdminUrl(null);
    setCreatedUid(null);
    setCreatedToken(null);
    setCreatedTitle('Untitled');
    setCreatedFormat('markdown');
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
      <Dialog.Content maxWidth="860px">
        {createdAdminUrl && createdUid && createdToken ? (
          <>
            <Dialog.Title>Document ready</Dialog.Title>
            <Dialog.Description size="2" color="gray" mb="4">
              Bookmark the admin link below — it's the only way back into this document with full
              control.
            </Dialog.Description>
            <Flex direction="column" gap="3" mb="4">
              <Box>
                <Text as="div" size="1" color="gray" mb="1">
                  Admin link
                </Text>
                <Copyable text={createdAdminUrl} multiline ariaLabel="Copy admin link" />
              </Box>
              {createdPassword && (
                <Box>
                  <Text as="div" size="1" color="gray" mb="1">
                    Password (shown once)
                  </Text>
                  <Copyable text={createdPassword} ariaLabel="Copy password" />
                </Box>
              )}
            </Flex>
            <Flex justify="end">
              <Button onClick={openCreated}>Open the document</Button>
            </Flex>
          </>
        ) : (
          <form onSubmit={submit}>
            <Dialog.Title>New document</Dialog.Title>
            <Dialog.Description size="2" color="gray" mb="4">
              Paste Markdown, upload a <Code>.md</Code> file, or import a previously exported
              <Code>.json</Code> bundle. It gets its own URL.
            </Dialog.Description>

            <Flex direction="column" gap="3">
              {!getDisplayName() && (
                <Box className="callout-soft">
                  <Text size="2" color="gray" as="p" mb="2">
                    Please set your display name first. It is the name shown on your edits and
                    comments.
                  </Text>
                  <TextField.Root
                    size="2"
                    value={userDisplayName ?? ''}
                    onChange={(e) => setUserDisplayNameState(e.target.value)}
                    placeholder="Your display name (e.g. Alex Cho)"
                    maxLength={80}
                    autoFocus
                  />
                </Box>
              )}

              <Box>
                <Text as="label" size="2" htmlFor="doc-name">
                  Document name
                  <Text as="span" size="1" color="gray">
                    {' '}
                    (optional
                    {docName.trim() ? '' : derivedTitle ? ` — will use “${derivedTitle}”` : ''})
                  </Text>
                </Text>
                <TextField.Root
                  id="doc-name"
                  value={docName}
                  onChange={(e) => setDocName(e.target.value)}
                  placeholder="Leave blank to use the document's title"
                  maxLength={200}
                  mt="1"
                  autoFocus={!!getDisplayName()}
                />
              </Box>

              <Box>
                <Text as="label" size="2" htmlFor="markdown-source">
                  {format === 'asciidoc' ? 'AsciiDoc source' : 'Markdown source'}
                </Text>
                <MarkdownDropZone onFile={handleFile}>
                  <TextArea
                    id="markdown-source"
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
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
                {/* Editing rights are granted via invite links in Access
                    control; no upload-time toggle. */}
              </Flex>

              {error && (
                <Callout.Root color="red" size="1">
                  <Callout.Text>{error}</Callout.Text>
                </Callout.Root>
              )}

              <Flex justify="end" gap="2">
                <Dialog.Close>
                  <Button variant="soft" color="gray">
                    Cancel
                  </Button>
                </Dialog.Close>
                <Button type="submit" disabled={submitting || !source || !userDisplayName}>
                  {submitting ? 'Uploading…' : 'Create document'}
                </Button>
              </Flex>
            </Flex>
          </form>
        )}
      </Dialog.Content>
    </Dialog.Root>
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
          <Text size="3" weight="medium">
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
      onKeyDown={(e) => {
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
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
          // Reset so re-selecting the same file still fires onChange.
          e.currentTarget.value = '';
        }}
      />
      <UploadIcon width="18" height="18" />
      <Text size="2">{label}</Text>
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

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / (60 * 60_000))}h ago`;
  return new Date(ts).toLocaleDateString();
}

function formatFullTs(ts: number): string {
  return new Date(ts).toLocaleString([], {
    dateStyle: 'full',
    timeStyle: 'medium',
  });
}
