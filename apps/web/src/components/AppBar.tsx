import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Flex, IconButton, Separator, Text, Tooltip } from '@radix-ui/themes';
import { HomeIcon } from '@radix-ui/react-icons';
import type { Role } from '../lib/api.js';
import { AppearanceToggle } from './AppearanceToggle.js';
import { UserMenu } from './UserMenu.js';

interface Props {
  /** Document title shown after the brand, when viewing/editing a doc. */
  docTitle?: string;
  role?: Role | undefined;
  forcedDisplayName?: string | null | undefined;
  /** Extra trailing slot for page-specific controls (e.g. Save in EditPage,
   *  admin settings gear in ViewPage). Rendered before the appearance/user. */
  trailing?: ReactNode;
}

/**
 * The persistent top bar, present on every page. Anchors the app's home
 * navigation, identity, and global appearance control.
 */
export function AppBar({ docTitle, role, forcedDisplayName, trailing }: Props) {
  return (
    <Flex align="center" gap="3" px="3" py="2" className="app-bar">
      <Tooltip content="Home">
        <IconButton variant="ghost" size="2" asChild>
          <Link to="/" aria-label="Home"><HomeIcon /></Link>
        </IconButton>
      </Tooltip>
      <Text weight="bold" size="3" className="app-brand" asChild>
        <Link to="/">Marginalia</Link>
      </Text>
      {docTitle && (
        <>
          <Separator orientation="vertical" size="2" />
          <Text size="2" className="app-bar-title" truncate>
            {docTitle}
          </Text>
        </>
      )}
      <span className="spacer" />
      {trailing}
      <AppearanceToggle />
      <UserMenu role={role} forcedDisplayName={forcedDisplayName} />
    </Flex>
  );
}
