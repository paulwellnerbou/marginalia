import { CheckIcon, Link2Icon } from '@radix-ui/react-icons';
import { IconButton, Tooltip } from '@radix-ui/themes';
import { useEffect, useRef, useState } from 'react';
import type { Role } from '../lib/api.js';
import { accessLinkFor } from '../lib/document-link.js';
import { reportError } from '../lib/log.js';

interface Props {
  uid: string;
  token: string;
  role: Role;
  className?: string;
}

/**
 * Hands the user back the invite link this device is holding.
 *
 * ViewPage strips the token from the address bar on arrival so sharing the
 * URL cannot leak access by accident. That leaves no way to move access to
 * a second device — an installed PWA on iOS cannot see what the browser
 * stored — so recovering the link has to be something the user asks for
 * outright. The tooltip names the role, because this is a bearer
 * credential and copying it is a decision, not a convenience.
 */
export function CopyAccessLinkButton({ uid, token, role, className }: Props) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(accessLinkFor(uid, token));
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      reportError('CopyAccessLinkButton.copy', err);
    }
  }

  const label = `Copy access link — grants ${role} access`;
  return (
    <Tooltip content={copied ? 'Copied!' : label}>
      <IconButton
        type="button"
        variant="ghost"
        size="1"
        color={copied ? 'green' : 'gray'}
        aria-label={label}
        {...(className ? { className } : {})}
        onClick={(event) => {
          // The card is wrapped in a full-bleed <a> overlay.
          event.preventDefault();
          event.stopPropagation();
          void copy();
        }}
      >
        {copied ? <CheckIcon /> : <Link2Icon />}
      </IconButton>
    </Tooltip>
  );
}
