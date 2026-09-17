import {
  BarChartIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DotsHorizontalIcon,
  DownloadIcon,
  GearIcon,
  MagnifyingGlassIcon,
  MixerHorizontalIcon,
  Share2Icon,
  SpeakerLoudIcon,
} from '@radix-ui/react-icons';
import { Button, DropdownMenu, Flex, IconButton, Popover, Tooltip } from '@radix-ui/themes';
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from 'react';
import type { Document, DocumentSettingsResponse, RenderedDocument } from '../lib/api.js';
import { useToolbarFit } from '../lib/useToolbarFit.js';
import { APP_ACCENT_COLOR } from '../styles/theme.js';
import { AccessControlDialog } from './AccessControlDialog.js';
import { CopyDocumentDialog } from './CopyDocumentDialog.js';
import { DocumentSettingsDialog } from './DocumentSettingsDialog.js';
import { DocumentStatsDialog } from './DocumentStatsDialog.js';
import { DownloadMenu, useDocumentDownloads } from './DownloadMenu.js';
import type { FoldedDialogHandle } from './foldedDialog.js';
import {
  ReadAloudControls,
  type ReadAloudHandle,
  type ReadAloudState,
} from './ReadAloudControls.js';

/**
 * How far the bar has folded to fit its pane. Search and the page's own
 * actions (Edit) stay on the bar at every stage: search is the quick
 * lookup a reader reaches for repeatedly, and Edit is the page's primary
 * action. Everything folded is occasional — statistics, downloads, the
 * admin dialogs — or, like read aloud, started once and then driven from
 * its own transport, which docks at the foot of a narrow pane anyway.
 */
const FIT_FULL = 0;
/** Occasional actions go behind "More"; the bar tightens its spacing. */
const FIT_FOLDED = 1;
/** The View button drops its label. */
const FIT_TIGHT = 2;

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
  /** Actions supplied by the page, such as Edit. Never folded. */
  children?: ReactNode;
  readAloud: {
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
}

/**
 * The toolbar over the document column. On a pane too narrow for it, the
 * occasional actions fold into a "More" menu instead of scrolling off the
 * end of a row that gives no sign it scrolls.
 *
 * The dialogs and the read-aloud controls stay mounted, in the same place,
 * at every stage; only their buttons come and go. Rotating a phone with a
 * dialog open, or mid-sentence, keeps both.
 */
export function DocumentToolbar({
  doc,
  rendered,
  source,
  theme,
  reviewExportEnabled,
  onDocSettingsChanged,
  viewControls,
  children,
  readAloud,
  searchOpen,
  onToggleSearch,
  uiScale,
}: Props) {
  const rowRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const downloadRef = useRef<HTMLButtonElement>(null);
  const statsRef = useRef<FoldedDialogHandle>(null);
  const copyRef = useRef<FoldedDialogHandle>(null);
  const settingsRef = useRef<FoldedDialogHandle>(null);
  const accessRef = useRef<FoldedDialogHandle>(null);
  const readAloudRef = useRef<ReadAloudHandle>(null);
  const [readAloudState, setReadAloudState] = useState<ReadAloudState>({
    supported: false,
    open: false,
    active: false,
  });
  /** A menu entry opened a dialog or panel that takes focus itself; the
   *  closing menu must not pull focus back to its button. */
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
  const fit = useToolbarFit(rowRef, FIT_TIGHT, `${doc.role}:${!!onAdminChange}:${uiScale}`);
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

  const readAloudLit = readAloudState.open || readAloudState.active;

  return (
    <Flex
      ref={rowRef}
      align="center"
      gap={fit === FIT_FULL ? '3' : '2'}
      px="3"
      py="2"
      className="doc-chrome"
    >
      {/* Always a menu, however much room the toolbar has: these are
        set-and-forget reading preferences, and spreading five of
        them across the bar pushed the per-document actions off the
        end of it on anything but a wide screen. */}
      <Popover.Root>
        <Popover.Trigger>
          {fit === FIT_TIGHT ? (
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
      {children}
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
      <ReadAloudControls
        ref={readAloudRef}
        {...readAloud}
        foldedInto={foldedInto}
        onStateChange={setReadAloudState}
      />
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
          {/* No Tooltip: focus comes back here from every folded dialog
            and panel, and a tooltip would open on each return. */}
          <DropdownMenu.Trigger>
            <IconButton
              ref={moreRef}
              variant="soft"
              color={APP_ACCENT_COLOR}
              size="2"
              className={`doc-search-trigger doc-more-trigger ${readAloudLit ? 'active' : ''}`}
              aria-label={
                readAloudState.active
                  ? 'More document actions, reading aloud'
                  : 'More document actions'
              }
              title="More document actions"
            >
              <DotsHorizontalIcon />
              {/* The folded speaker's lit state, which would otherwise
                be nowhere on screen once its panel is closed. */}
              {readAloudState.active && <span className="doc-more-indicator" aria-hidden />}
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
                {readAloudState.supported && (
                  <DropdownMenu.CheckboxItem
                    checked={readAloudState.open}
                    onSelect={() => {
                      handedOff.current = !readAloudState.open;
                      readAloudRef.current?.toggle();
                    }}
                  >
                    <SpeakerLoudIcon />
                    {readAloudState.active ? 'Read-aloud controls' : 'Read aloud'}
                  </DropdownMenu.CheckboxItem>
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
                {onAdminChange && (
                  <>
                    <DropdownMenu.Separator />
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
