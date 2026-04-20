import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Flex, Separator, Text } from '@radix-ui/themes';
import type { DocumentFormat, Role } from '../lib/api.js';
import { AppearanceToggle } from './AppearanceToggle.js';
import { FormatBadge } from './FormatBadge.js';
import { UserMenu } from './UserMenu.js';

interface Props {
  /** Document title shown after the brand, when viewing/editing a doc. */
  docTitle?: string;
  role?: Role | undefined;
  /** Source flavour of the currently-open doc. Drives the MARKDOWN /
   *  ASCIIDOC badge next to the title — omitted on the home page. */
  format?: DocumentFormat;
  /** Extra trailing slot for page-specific controls (e.g. Save in EditPage,
   *  admin settings gear in ViewPage). Rendered before the appearance/user. */
  trailing?: ReactNode;
}

/**
 * The persistent top bar, present on every page. Anchors the app's home
 * navigation, identity, and global appearance control.
 */
export function AppBar({ docTitle, role, format, trailing }: Props) {
  const brandGradientId = useId().replace(/:/g, '');

  return (
    <Flex align="center" gap="3" px="3" py="2" className="app-bar">
      <Link to="/" aria-label="Marginalia home" className="app-brand">
        <span className="app-brand-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" className="app-brand-icon-svg">
            <defs>
              <linearGradient id={brandGradientId} x1="1" y1="3" x2="22" y2="20" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="var(--accent-11)" />
                <stop offset="48%" stopColor="var(--ruby-11)" />
                <stop offset="100%" stopColor="var(--gray-12)" />
              </linearGradient>
            </defs>
            <path
              d="M3 10.75L12 3.75L21 10.75"
              fill="none"
              stroke={`url(#${brandGradientId})`}
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M5.5 9.9V19.25H18.5V9.9"
              fill="none"
              stroke={`url(#${brandGradientId})`}
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M10 19.25V13.75H14V19.25"
              fill="none"
              stroke={`url(#${brandGradientId})`}
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="app-brand-wordmark">Marginalia</span>
      </Link>
      {docTitle && (
        <>
          <Separator orientation="vertical" size="2" />
          <Text size="2" className="app-bar-title" truncate>
            {docTitle}
          </Text>
          {format && <FormatBadge format={format} />}
        </>
      )}
      <span className="spacer" />
      {trailing}
      <AppearanceToggle />
      <UserMenu role={role} />
    </Flex>
  );
}
