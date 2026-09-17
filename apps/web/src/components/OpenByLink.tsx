import { Link2Icon } from '@radix-ui/react-icons';
import { Box, Button, Flex, IconButton, Text, TextField, Tooltip } from '@radix-ui/themes';
import { ScanLineIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { parseDocumentLink } from '../lib/document-link.js';
import { canScanQr, routeForScannedCode } from '../lib/qr-scan.js';
import { QrScanDialog } from './QrScanDialog.js';

/**
 * Opens a document from a link the user pastes in.
 *
 * "Your documents" is per-browser localStorage, and an installed app gets
 * its own storage on iOS — so a freshly installed PWA shows an empty list
 * even to someone with plenty of documents, and no link the browser can
 * offer will hand them over. Re-pasting the invite URL is the way across,
 * and the server keeps invite rows alive so that re-claim succeeds.
 *
 * Scanning covers the same gap when the link is on another screen: the
 * access-link dialog shows it as a QR code, and a phone with an empty
 * list has no clipboard to paste it from.
 */
export function OpenByLink() {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  // Read once: support does not change while the page is open.
  const [canScan] = useState(canScanQr);

  function scanned(text: string): string | null {
    const result = routeForScannedCode(text, window.location.host);
    if (result.ok) {
      setError(null);
      navigate(result.path);
      return null;
    }
    return result.reason === 'other-site'
      ? `That code is for ${result.host}, a different Marginalia.`
      : 'That is not a Marginalia link. Try the QR code from an access link.';
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const result = parseDocumentLink(value, window.location.host);
    if (result.ok) {
      setError(null);
      navigate(result.path);
      return;
    }
    setError(messageFor(result));
  }

  return (
    <Box>
      <Text size="2" weight="medium" as="p" mb="1">
        Open from a link
      </Text>
      <Text size="2" color="gray" as="p" mb="2">
        Paste an invite link to open a document here — handy on a new device, or in the installed
        app, which starts with its own empty list.
      </Text>
      <form onSubmit={submit}>
        <Flex gap="2" align="start" wrap="wrap">
          <Box style={{ flex: '1 1 22rem', minWidth: 0 }}>
            <TextField.Root
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                if (error) setError(null);
              }}
              placeholder={`${window.location.origin}/d/…`}
              aria-label="Document link"
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
            >
              <TextField.Slot>
                <Link2Icon />
              </TextField.Slot>
              {canScan && (
                <TextField.Slot side="right">
                  <Tooltip content="Scan a QR code">
                    <IconButton
                      type="button"
                      size="1"
                      variant="ghost"
                      aria-label="Scan a QR code"
                      onClick={() => setScanOpen(true)}
                    >
                      <ScanLineIcon size={15} />
                    </IconButton>
                  </Tooltip>
                </TextField.Slot>
              )}
            </TextField.Root>
          </Box>
          <Button type="submit">Open</Button>
        </Flex>
      </form>
      {error && (
        <Text size="1" color="red" as="p" mt="2" role="alert">
          {error}
        </Text>
      )}
      {canScan && <QrScanDialog open={scanOpen} onOpenChange={setScanOpen} onScan={scanned} />}
    </Box>
  );
}

function messageFor(result: Exclude<ReturnType<typeof parseDocumentLink>, { ok: true }>): string {
  switch (result.reason) {
    case 'empty':
      return 'Paste a document link first.';
    case 'other-site':
      return `That link is for ${result.host}, a different Marginalia. Open it there instead.`;
    case 'unrecognized':
      // A link with no token parses fine, so this must not read as though
      // the token were required — it is advice about access, not shape.
      return `That doesn't look like a document link. It should start ${window.location.origin}/d/. Paste the whole line from your invite: the part after the document id is what carries your access.`;
  }
}
