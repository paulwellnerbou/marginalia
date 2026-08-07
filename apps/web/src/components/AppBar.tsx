import { Flex, Separator, Text } from '@radix-ui/themes';
import { type ReactNode, useId } from 'react';
import { Link } from 'react-router-dom';
import type { DocumentFormat, Role } from '../lib/api.js';
import { AppearanceToggle } from './AppearanceToggle.js';
import { FormatBadge } from './FormatBadge.js';
import { UserMenu } from './UserMenu.js';

interface Props {
  /** Document title shown after the brand, when viewing/editing a doc. */
  docTitle?: string;
  role?: Role | undefined;
  docUid?: string;
  passwordProtected?: boolean;
  onLogout?: () => void;
  /** Source flavour of the currently-open doc. Drives the MARKDOWN /
   *  ASCIIDOC badge next to the title — omitted on the home page. */
  format?: DocumentFormat;
  /** Extra trailing slot for page-specific controls (e.g. Save/Cancel in
   *  EditPage). Rendered before the appearance/user. */
  trailing?: ReactNode;
  /** Expand the user trigger to show the current display name. */
  showUserName?: boolean;
}

/**
 * The persistent top bar, present on every page. Anchors the app's home
 * navigation, identity, and global appearance control.
 */
export function AppBar({
  docTitle,
  role,
  docUid,
  passwordProtected,
  onLogout,
  format,
  trailing,
  showUserName,
}: Props) {
  const brandGradientId = useId().replace(/:/g, '');

  return (
    <Flex align="center" gap="3" px="3" py="2" className="app-bar">
      <Link to="/" aria-label="Marginalia home" className="app-brand">
        <span className="app-brand-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" className="app-brand-icon-svg" aria-hidden="true">
            <defs>
              <linearGradient
                id={brandGradientId}
                x1="1"
                y1="3"
                x2="22"
                y2="20"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0%" stopColor="var(--ui-accent-strong)" />
                <stop offset="48%" stopColor="var(--ui-accent-muted-strong)" />
                <stop offset="100%" stopColor="var(--gray-12)" />
              </linearGradient>
            </defs>
            {/* The app icon's mark: an annotation bracket in the margin
                holding a passage. The gradient runs left-to-right, so the
                bracket lands on the accent and the text on the gray end. */}
            <path
              d="M8 5.5H5V18.5H8"
              fill="none"
              stroke={`url(#${brandGradientId})`}
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M11.6 8.4H19.4"
              fill="none"
              stroke={`url(#${brandGradientId})`}
              strokeWidth="1.9"
              strokeLinecap="round"
            />
            <path
              d="M11.6 12H17.6"
              fill="none"
              stroke={`url(#${brandGradientId})`}
              strokeWidth="1.9"
              strokeLinecap="round"
            />
            <path
              d="M11.6 15.6H15.6"
              fill="none"
              stroke={`url(#${brandGradientId})`}
              strokeWidth="1.9"
              strokeLinecap="round"
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
      <UserMenu
        role={role}
        showName={showUserName ?? false}
        {...(docUid ? { docUid } : {})}
        {...(passwordProtected !== undefined ? { passwordProtected } : {})}
        {...(onLogout ? { onLogout } : {})}
      />
    </Flex>
  );
}
