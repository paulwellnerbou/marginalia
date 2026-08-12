import { CheckIcon, CopyIcon } from '@radix-ui/react-icons';
import { Button, Code, Dialog, Flex, IconButton, Text, Tooltip } from '@radix-ui/themes';
import { QrCodeIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { reportError } from '../lib/log.js';
import { PairingQr } from './PairingQr.js';

interface Props {
  /** The value to display and copy to the clipboard. */
  text: string;
  /** If true, the copy icon sits in the upper-right corner so it doesn't
   *  collide with wrapped content. Defaults to false (icon at the right
   *  edge, vertically centered). */
  multiline?: boolean;
  /** Accessible label for the copy action. Defaults to "Copy". */
  ariaLabel?: string;
  /** Radix Code size. */
  size?: '1' | '2' | '3';
  /** If true, show an adjacent button that opens a QR code containing text. */
  qrCode?: boolean;
  /** Optional class for context-specific presentation. */
  className?: string;
}

/**
 * A small, self-contained "copyable code block" with a subtle copy icon
 * and a check-mark confirmation animation on success. Replaces the big
 * "Copy X" buttons that used to live next to credentials.
 */
export function Copyable({
  text,
  multiline = false,
  ariaLabel = 'Copy',
  size = '2',
  qrCode = false,
  className,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const resetTimer = useRef<number | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      reportError('Copyable.copy', err);
    }
  }

  return (
    <div
      className={`copyable ${multiline ? 'copyable-multiline' : 'copyable-inline'}${className ? ` ${className}` : ''}`}
    >
      <div className="copyable-surface">
        <Code size={size} className="copyable-text">
          {text}
        </Code>
        {qrCode && (
          <Tooltip content="Show QR code">
            <IconButton
              type="button"
              size="1"
              variant="ghost"
              color="gray"
              aria-label="Show QR code for this link"
              className="copyable-btn"
              onClick={() => setQrOpen(true)}
            >
              <QrCodeIcon size={15} />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip content={copied ? 'Copied!' : ariaLabel}>
          <IconButton
            type="button"
            size="1"
            variant="ghost"
            color={copied ? 'green' : 'gray'}
            aria-label={ariaLabel}
            className={`copyable-btn ${copied ? 'copyable-btn--copied' : ''}`}
            onClick={copy}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </IconButton>
        </Tooltip>
      </div>

      {qrCode && (
        <Dialog.Root open={qrOpen} onOpenChange={setQrOpen}>
          <Dialog.Content maxWidth="26rem">
            <Dialog.Title>Access link QR code</Dialog.Title>
            <Dialog.Description size="2" color="gray" mb="4">
              Scan this code to open the document with this access link.
            </Dialog.Description>
            <Flex direction="column" align="center" gap="3">
              <PairingQr value={text} ariaLabel="Document access link QR code" />
              <Text size="1" color="gray" align="center">
                This code includes the access token. Treat it like the link itself.
              </Text>
            </Flex>
            <Flex justify="end" mt="4">
              <Dialog.Close>
                <Button variant="soft">Done</Button>
              </Dialog.Close>
            </Flex>
          </Dialog.Content>
        </Dialog.Root>
      )}
    </div>
  );
}
