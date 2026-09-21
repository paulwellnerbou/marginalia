import {
  BarChartIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DotsHorizontalIcon,
  DownloadIcon,
  FilePlusIcon,
  GearIcon,
  MagnifyingGlassIcon,
  MixerHorizontalIcon,
  Pencil1Icon,
  Share2Icon,
} from '@radix-ui/react-icons';
import { Button, DropdownMenu, Flex, IconButton, Popover, Tooltip } from '@radix-ui/themes';
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Document, DocumentSettingsResponse, RenderedDocument } from '../lib/api.js';
import { useToolbarFit } from '../lib/useToolbarFit.js';
import { APP_ACCENT_COLOR } from '../styles/theme.js';
import { AccessControlDialog } from './AccessControlDialog.js';
import { CopyDocumentDialog } from './CopyDocumentDialog.js';
import { DocumentSettingsDialog } from './DocumentSettingsDialog.js';
import { DocumentStatsDialog } from './DocumentStatsDialog.js';
import { DownloadMenu, useDocumentDownloads } from './DownloadMenu.js';
import type { FoldedDialogHandle } from './foldedDialog.js';
import { NewFolderDocumentDialog } from './NewFolderDocumentDialog.js';
import { ReadAloudControls } from './ReadAloudControls.js';

/**
 * How far the bar has folded to fit its pane. Search and read aloud never
 * fold: one is the quick lookup a reader reaches for over and over, the
 * other is what a phone reader came to the bar for, and its speaker is the
 * only sign on the bar that speech is running. What folds is occasional —
 * statistics, downloads, the admin dialogs.
 */
const FIT_FULL = 0;
/** Occasional actions go behind "More"; the bar tightens its spacing. */
const FIT_FOLDED = 1;
/** The View button drops its label. */
const FIT_TIGHT = 2;
/**
 * Edit follows the rest into the menu. Last, because it is the one action
 * an editor came for, but ahead of leaving the row to scroll sideways: the
 * "More" button is its last child, so an overflowing row hides the very
 * button every folded action is behind.
 */
const FIT_EDIT_FOLDED = 3;

interface Props {
  doc: Document;
  rendered: RenderedDocument;
  /** Live source, which may differ from `doc.source` after an accepted proposal. */
  source: string;
  theme: string;
  reviewExportEnabled: boolean;
  onDocSettingsChanged?: ((uid: string, s: Partial<DocumentSettingsResponse>) => void) | undefined;
  /** Reading preferences, shown in the View popover. */
  viewControls: ReactNode;
  /** Where Edit leads, for readers allowed to edit. */
  editHref?: string | undefined;
  readAloud: {
    docUid: string;
    rootRef: RefObject<HTMLElement | null>;
    htmlKey: string;
    frontmatter: Record<string, unknown>;
    inlineCommentsOffset: number;
    dock: HTMLElement | null;
  };
  searchOpen: boolean;
  onToggleSearch: () => void;
  /** Interface size: it resizes every control, folded ones included. */
  uiScale: number;
  /** Opens "Add a document" — also reached from the folder list. */
  newDocumentRef: RefObject<FoldedDialogHandle | null>;
}

/**
 * The toolbar over the document column. On a pane too narrow for it, the
 * occasional actions fold into a "More" menu instead of scrolling off the
 * end of a row that gives no sign it scrolls.
 *
 * The dialogs stay mounted, in the same place, at every stage; only their
 * buttons come and go. Rotating a phone with a dialog open keeps it.
 */
export function DocumentToolbar({
  doc,
  rendered,
  source,
  theme,
  reviewExportEnabled,
  onDocSettingsChanged,
  viewControls,
  editHref,
  readAloud,
  searchOpen,
  onToggleSearch,
  uiScale,
  newDocumentRef,
}: Props) {
  const rowRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const downloadRef = useRef<HTMLButtonElement>(null);
  const statsRef = useRef<FoldedDialogHandle>(null);
  const copyRef = useRef<FoldedDialogHandle>(null);
  const settingsRef = useRef<FoldedDialogHandle>(null);
  const accessRef = useRef<FoldedDialogHandle>(null);
  /** A menu entry opened a dialog that takes focus itself; the closing
   *  menu must not pull focus back to its button. */
  const handedOff = useRef(false);
  /**
   * Download opens in place of the overflow menu's other entries rather
   * than as a submenu. The overflow menu is only ever shown on a narrow
   * pane, often a phone, where a submenu has no room beside its parent on
   * either side and opens mostly off screen.
   */
  const [moreView, setMoreView] = useState<'actions' | 'download'>('actions');
  const moreMenuRef = useRef<HTMLDivElement>(null);
  /**
   * Swapping the list unmounts the focused entry, so focus is placed again
   * once the new one renders: on the entry marked for it after a key, on
   * the menu itself after a tap, which would otherwise light that entry up
   * as if it had been pressed.
   */
  const refocusMenu = useRef<'entry' | 'menu' | null>(null);
  const pressedByPointer = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: moreView is the trigger — the entry to focus exists only once the swapped list has rendered.
  useLayoutEffect(() => {
    const target = refocusMenu.current;
    refocusMenu.current = null;
    const menu = moreMenuRef.current;
    if (target === 'menu') menu?.focus({ preventScroll: true });
    else if (target === 'entry') menu?.querySelector<HTMLElement>('[data-menu-refocus]')?.focus();
  }, [moreView]);
  const showMoreView = (view: 'actions' | 'download') => {
    refocusMenu.current = pressedByPointer.current ? 'menu' : 'entry';
    pressedByPointer.current = false;
    setMoreView(view);
  };
  const drillEntryProps = {
    onPointerDown: () => {
      pressedByPointer.current = true;
    },
    onKeyDown: () => {
      pressedByPointer.current = false;
    },
  };

  const onAdminChange = doc.role === 'admin' ? onDocSettingsChanged : undefined;
  const canAddDocument = doc.role === 'admin' || doc.role === 'editor';
  const fit = useToolbarFit(
    rowRef,
    FIT_EDIT_FOLDED,
    `${doc.role}:${!!onAdminChange}:${!!editHref}:${uiScale}`,
  );
  const folded = fit >= FIT_FOLDED;
  const foldedInto = folded ? moreRef : undefined;

  const downloads = useDocumentDownloads({
    doc,
    source,
    theme,
    reviewExportEnabled,
    returnFocus: folded ? moreRef : downloadRef,
  });

  const openFromMenu = (target: RefObject<FoldedDialogHandle | null>) => {
    handedOff.current = true;
    target.current?.open();
  };

  return (
    <Flex
      ref={rowRef}
      align="center"
      gap={fit === FIT_FULL ? '3' : '2'}
      px={fit >= FIT_TIGHT ? '2' : '3'}
      py="2"
      className="doc-chrome"
    >
      {/* Always a menu, however much room the toolbar has: these are
        set-and-forget reading preferences, and spreading five of
        them across the bar pushed the per-document actions off the
        end of it on anything but a wide screen. */}
      <Popover.Root>
        <Popover.Trigger>
          {fit >= FIT_TIGHT ? (
            <IconButton
              variant="soft"
              size="2"
              className="doc-view-trigger"
              aria-label="View"
              title="View"
            >
              <MixerHorizontalIcon />
            </IconButton>
          ) : (
            <Button variant="soft" size="2" className="doc-view-trigger">
              <MixerHorizontalIcon />
              View
            </Button>
          )}
        </Popover.Trigger>
        <Popover.Content size="1" align="start" className="doc-view-popover">
          {viewControls}
        </Popover.Content>
      </Popover.Root>
      <span className="spacer" />
      <DocumentStatsDialog ref={statsRef} rendered={rendered} foldedInto={foldedInto} />
      {/* Download is available to any reader — unlike settings /
        access control which are admin-only. Sits next to the
        gear so the whole toolbar cluster reads as a single set
        of per-document actions. */}
      {!folded && <DownloadMenu downloads={downloads} triggerRef={downloadRef} />}
      {downloads.dialog}
      {editHref && fit < FIT_EDIT_FOLDED && (
        <Button variant="soft" asChild>
          <Link to={editHref}>Edit</Link>
        </Button>
      )}
      {canAddDocument && (
        <NewFolderDocumentDialog ref={newDocumentRef} doc={doc} foldedInto={foldedInto} />
      )}
      {onAdminChange && (
        <>
          <CopyDocumentDialog ref={copyRef} doc={doc} foldedInto={foldedInto} />
          <DocumentSettingsDialog
            ref={settingsRef}
            doc={doc}
            onChange={onAdminChange}
            foldedInto={foldedInto}
          />
          <AccessControlDialog
            ref={accessRef}
            doc={doc}
            onChange={onAdminChange}
            foldedInto={foldedInto}
          />
        </>
      )}
      <ReadAloudControls {...readAloud} />
      <Tooltip content={searchOpen ? 'Close document search' : 'Search document'}>
        <IconButton
          variant="soft"
          color={APP_ACCENT_COLOR}
          size="2"
          className={`doc-search-trigger ${searchOpen ? 'active' : ''}`}
          onClick={onToggleSearch}
          aria-label={searchOpen ? 'Close document search' : 'Search document'}
        >
          <MagnifyingGlassIcon />
        </IconButton>
      </Tooltip>
      {folded && (
        <DropdownMenu.Root
          onOpenChange={(open) => {
            if (open) setMoreView('actions');
          }}
        >
          {/* No Tooltip: focus comes back here from every folded dialog,
            and a tooltip would open on each return. */}
          <DropdownMenu.Trigger>
            <IconButton
              ref={moreRef}
              variant="soft"
              color={APP_ACCENT_COLOR}
              size="2"
              className="doc-search-trigger"
              aria-label="More document actions"
              title="More document actions"
            >
              <DotsHorizontalIcon />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content
            ref={moreMenuRef}
            align="end"
            className="doc-more-menu"
            onCloseAutoFocus={(event) => {
              if (handedOff.current || downloads.dialogOpen) event.preventDefault();
              handedOff.current = false;
            }}
            onKeyDown={(event) => {
              if (moreView === 'download' && event.key === 'ArrowLeft') {
                event.preventDefault();
                pressedByPointer.current = false;
                showMoreView('actions');
              }
            }}
          >
            {moreView === 'download' ? (
              <>
                <DropdownMenu.Item
                  {...drillEntryProps}
                  data-menu-refocus
                  aria-label="Download, back to all actions"
                  onSelect={(event) => {
                    event.preventDefault();
                    showMoreView('actions');
                  }}
                >
                  <ChevronLeftIcon />
                  Download
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
                {downloads.items}
              </>
            ) : (
              <>
                {editHref && fit >= FIT_EDIT_FOLDED && (
                  <>
                    <DropdownMenu.Item asChild>
                      <Link to={editHref}>
                        <Pencil1Icon />
                        Edit
                      </Link>
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator />
                  </>
                )}
                <DropdownMenu.Item onSelect={() => openFromMenu(statsRef)}>
                  <BarChartIcon />
                  Document statistics
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  {...drillEntryProps}
                  data-menu-refocus
                  disabled={downloads.busy}
                  onSelect={(event) => {
                    event.preventDefault();
                    showMoreView('download');
                  }}
                  onKeyDown={(event) => {
                    pressedByPointer.current = false;
                    if (event.key !== 'ArrowRight') return;
                    event.preventDefault();
                    showMoreView('download');
                  }}
                >
                  <DownloadIcon />
                  Download
                  <ChevronRightIcon className="doc-more-menu-forward" />
                </DropdownMenu.Item>
                {canAddDocument && (
                  <>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item onSelect={() => openFromMenu(newDocumentRef)}>
                      <FilePlusIcon />
                      Add a document
                    </DropdownMenu.Item>
                  </>
                )}
                {/* Admins can add documents too, so the separator above
                    already starts this group. */}
                {onAdminChange && (
                  <>
                    <DropdownMenu.Item onSelect={() => openFromMenu(copyRef)}>
                      <CopyIcon />
                      Copy document
                    </DropdownMenu.Item>
                    <DropdownMenu.Item onSelect={() => openFromMenu(settingsRef)}>
                      <GearIcon />
                      Document settings
                    </DropdownMenu.Item>
                    <DropdownMenu.Item onSelect={() => openFromMenu(accessRef)}>
                      <Share2Icon />
                      Access control
                    </DropdownMenu.Item>
                  </>
                )}
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      )}
    </Flex>
  );
}
