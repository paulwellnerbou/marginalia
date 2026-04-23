import type { ReactNode } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '@radix-ui/react-icons';
import { Button, Flex, Text } from '@radix-ui/themes';

interface DiscussionThreadProps {
  threadId: string;
  quote?: string | null | undefined;
  quoteTitle: string;
  onJump?: (() => void) | undefined;
  summary: ReactNode;
  toolbarActions?: ReactNode | undefined;
  headerBadge?: ReactNode | undefined;
  focused: boolean;
  flashPhase?: 'a' | 'b' | null | undefined;
  collapsed: boolean;
  className?: string | undefined;
  onToggleCollapsed: () => void;
  children: ReactNode;
}

interface DiscussionEntryProps {
  authorName: string;
  authorId?: string | undefined;
  createdAt: number;
  surface: ReactNode;
  actions?: ReactNode | undefined;
  badge?: ReactNode | undefined;
  className?: string | undefined;
}

export function DiscussionThread({
  threadId,
  quote,
  quoteTitle,
  onJump,
  summary,
  toolbarActions,
  headerBadge,
  focused,
  flashPhase,
  collapsed,
  className,
  onToggleCollapsed,
  children,
}: DiscussionThreadProps) {
  const displayQuote = typeof quote === 'string' && quote.trim().length > 0 ? quote : null;
  const showAnchor = displayQuote !== null || onJump !== undefined;

  return (
    <div
      className={joinClasses(
        'anchor-group',
        focused ? 'thread-focused' : null,
        flashPhase ? `thread-flashing-${flashPhase}` : null,
        className,
      )}
      data-comment-thread-id={threadId}
    >
      {headerBadge ? <div className="anchor-header-badge">{headerBadge}</div> : null}
      {showAnchor && (
        <button
          type="button"
          className="anchor-quote"
          title={quoteTitle}
          onClick={onJump}
          disabled={!onJump}
        >
          <span className="jump-icon" aria-hidden>
            ↗
          </span>
          {displayQuote ? `“${displayQuote}”` : 'Jump to document location'}
        </button>
      )}

      <Flex align="center" gap="2" className="thread-toolbar">
        <Button
          size="1"
          variant="ghost"
          color="gray"
          className="thread-collapse-button"
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
          {collapsed ? 'Expand thread' : 'Collapse thread'}
        </Button>
        <Text size="1" color="gray">
          {summary}
        </Text>
        <span className="spacer" />
        {toolbarActions}
      </Flex>

      {!collapsed && children}
    </div>
  );
}

export function DiscussionEntry({
  authorName,
  authorId,
  createdAt,
  surface,
  actions,
  badge,
  className,
}: DiscussionEntryProps) {
  return (
    <div className={joinClasses('comment', className)}>
      <Avatar name={authorName} id={authorId ?? authorName} />
      <div className="comment-col">
        <div className="comment-surface">{surface}</div>
        {badge ? <div className="comment-badge-row">{badge}</div> : null}
      </div>
      <div className="comment-aside">
        <Text size="1" color="gray" className="comment-ts" title={`${authorName} · ${formatFullTs(createdAt)}`}>
          {formatTs(createdAt)}
        </Text>
        {actions}
      </div>
    </div>
  );
}

function Avatar({ name, id }: { name: string; id: string }) {
  const letters = avatarInitials(name);
  const hue = hashHue(id);
  const style = {
    backgroundColor: `hsl(${hue} 55% 45%)`,
  } as const;
  return (
    <div className="comment-avatar" style={style} aria-hidden title={name}>
      {letters}
    </div>
  );
}

export function avatarInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    return parts
      .map((part) => Array.from(part)[0] ?? '')
      .join('')
      .toUpperCase();
  }
  return Array.from(trimmed).slice(0, 2).join('');
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

export function formatTs(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString();
}

export function formatFullTs(ts: number): string {
  return new Date(ts).toLocaleString([], {
    dateStyle: 'full',
    timeStyle: 'medium',
  });
}

function joinClasses(...values: Array<string | null | undefined | false>): string {
  return values.filter(Boolean).join(' ');
}
