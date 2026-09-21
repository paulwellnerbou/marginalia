import { Box, Flex, SegmentedControl, Text, TextArea, TextField } from '@radix-ui/themes';
import { useRef, useState } from 'react';
import type { DocumentFormat } from '../lib/api.js';
import {
  deriveDisplayName,
  getClientId,
  getDisplayName,
  type Identity,
  setDisplayName,
} from '../lib/identity.js';
import { FileDropZone } from './FileDropZone.js';

export interface NewDocumentSeed {
  source?: string | undefined;
  format?: DocumentFormat | undefined;
  docName?: string | undefined;
}

/**
 * What a person fills in to start a document, wherever they start it: the
 * home page's "New document" and a folder's "Add a document" share it, so
 * the two can only differ in what they do with the result.
 */
export function useNewDocumentFields(defaults: { source: string; format: DocumentFormat }) {
  const [source, setSource] = useState(defaults.source);
  const [format, setFormat] = useState<DocumentFormat>(defaults.format);
  // The DOCUMENT's name. Empty → the title the source gives itself.
  const [docName, setDocName] = useState('');
  // Asked for inline only while none is set globally.
  const [userDisplayName, setUserDisplayName] = useState<string | null>(() => getDisplayName());

  // deriveDisplayName answers 'Anonymous' for an empty source, which is no title.
  const derivedTitle = !source.trim()
    ? ''
    : format === 'asciidoc'
      ? deriveAsciidocTitle(source)
      : deriveDisplayName(source);

  return {
    source,
    setSource,
    format,
    setFormat,
    docName,
    setDocName,
    userDisplayName,
    setUserDisplayName,
    derivedTitle,
    effectiveDocName: docName.trim() || derivedTitle,
    async loadFile(file: File) {
      setSource(await file.text());
      setFormat(formatFromFilename(file.name));
    },
    /** Stores the inline display name. Null while there is none to use. */
    identityForSubmit(): Identity | null {
      const user = (userDisplayName ?? '').trim();
      if (!user) return null;
      setDisplayName(user);
      return { clientId: getClientId(), displayName: user.slice(0, 80) };
    },
    reset(seed: NewDocumentSeed | null = null) {
      setSource(seed?.source ?? defaults.source);
      setFormat(seed?.format ?? defaults.format);
      setDocName(seed?.docName ?? '');
    },
  };
}

export type NewDocumentFieldsState = ReturnType<typeof useNewDocumentFields>;

export const DISPLAY_NAME_REQUIRED =
  'Please set your display name first. It is the name shown on your edits and comments.';

export function NewDocumentFields({
  fields,
  onBundleFile,
  sourcePlaceholder,
}: {
  fields: NewDocumentFieldsState;
  /** Present where an exported JSON bundle may be dropped too. */
  onBundleFile?: ((file: File) => void | Promise<void>) | undefined;
  sourcePlaceholder?: string | undefined;
}) {
  const { docName, derivedTitle, format } = fields;
  const bundles = !!onBundleFile;
  const accepts = (file: File) => isSourceFile(file) || (bundles && isBundleFile(file));
  const onFile = (file: File) =>
    onBundleFile && isBundleFile(file) ? onBundleFile(file) : fields.loadFile(file);

  return (
    <>
      {!getDisplayName() && (
        <Box className="callout-soft">
          <Text size="2" color="gray" as="p" mb="2">
            {DISPLAY_NAME_REQUIRED}
          </Text>
          <TextField.Root
            size="2"
            value={fields.userDisplayName ?? ''}
            onChange={(e) => fields.setUserDisplayName(e.target.value)}
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
          onChange={(e) => fields.setDocName(e.target.value)}
          placeholder="Leave blank to use the document's title"
          maxLength={200}
          mt="1"
          autoFocus={!!getDisplayName()}
        />
      </Box>

      <Box>
        <Flex align="center" justify="between" gap="3">
          <Text as="label" size="2" htmlFor="markdown-source">
            {format === 'asciidoc' ? 'AsciiDoc source' : 'Markdown source'}
          </Text>
          <SegmentedControl.Root
            size="1"
            value={format}
            onValueChange={(v) => fields.setFormat(v as DocumentFormat)}
            aria-label="Format"
          >
            <SegmentedControl.Item value="markdown">Markdown</SegmentedControl.Item>
            <SegmentedControl.Item value="asciidoc">AsciiDoc</SegmentedControl.Item>
          </SegmentedControl.Root>
        </Flex>
        <SourceDropZone accepts={accepts} onFile={onFile} bundles={bundles}>
          <TextArea
            id="markdown-source"
            value={fields.source}
            onChange={(e) => fields.setSource(e.target.value)}
            placeholder={sourcePlaceholder}
            rows={14}
            spellCheck={false}
            className="markdown-textarea"
            mt="1"
          />
        </SourceDropZone>
      </Box>

      <FileDropZone
        accept={bundles ? `${SOURCE_ACCEPT},.json,application/json` : SOURCE_ACCEPT}
        acceptFile={accepts}
        onFile={onFile}
        label={
          bundles
            ? 'Drop a Markdown, AsciiDoc, or JSON bundle file — or click to browse'
            : 'Drop a Markdown or AsciiDoc file — or click to browse'
        }
      />
    </>
  );
}

const SOURCE_ACCEPT = '.md,.markdown,.mdx,.adoc,.asciidoc,text/markdown';

/**
 * The browser's `accept` attribute only gates the native file picker — a
 * drop reaches the handler whatever it is. One filter for both drop zones,
 * so they cannot drift into accepting different files.
 */
function isSourceFile(file: File): boolean {
  if (file.type === 'text/markdown') return true;
  const n = file.name.toLowerCase();
  return (
    n.endsWith('.md') ||
    n.endsWith('.markdown') ||
    n.endsWith('.mdx') ||
    n.endsWith('.adoc') ||
    n.endsWith('.asciidoc')
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
 * Drop target around the textarea, with a subtle overlay while a file is
 * dragged over. The drop only fires `onFile`; the child keeps its state.
 */
function SourceDropZone({
  children,
  accepts,
  onFile,
  bundles,
}: {
  children: React.ReactNode;
  accepts: (file: File) => boolean;
  onFile: (file: File) => void | Promise<void>;
  bundles: boolean;
}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop-target wrapper around an editable textarea; not a clickable element
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
        if (file && accepts(file)) void onFile(file);
      }}
    >
      {children}
      {over && (
        <div className="drop-zone-overlay">
          <Text size="3" weight="medium">
            {bundles
              ? 'Drop Markdown, AsciiDoc, or a JSON bundle to load it'
              : 'Drop Markdown or AsciiDoc to load it'}
          </Text>
        </div>
      )}
    </div>
  );
}

/**
 * Pull a plausible title out of AsciiDoc source. Preference order:
 *   1. The document title line `= Title`
 *   2. The first non-blank, non-attribute line
 *
 * `deriveDisplayName` only recognises markdown heading syntax; this plays
 * its role for AsciiDoc when the name field is left blank.
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
