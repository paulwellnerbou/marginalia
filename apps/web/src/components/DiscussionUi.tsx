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
  focused: boolean;
  collapsed: boolean;
  className?: string | undefined;
  onToggleCollapsed: () => void;
  children: ReactNode;
}

interface DiscussionEntryProps {
  authorName: string;
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
  focused,
  collapsed,
  className,
  onToggleCollapsed,
  children,
}: DiscussionThreadProps) {
  return (
    <div
      className={joinClasses('anchor-group', focused ? 'thread-focused' : null, className)}
      data-comment-thread-id={threadId}
    >
      {quote && (
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
          “{quote}”
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
  createdAt,
  surface,
  actions,
  badge,
  className,
}: DiscussionEntryProps) {
  return (
    <div className={joinClasses('comment', className)}>
      <Flex align="baseline" gap="2" mb="1" className="comment-meta">
        <Text weight="medium" size="2" className="comment-author">
          {authorName}
        </Text>
        <Text size="1" color="gray" className="comment-ts" title={formatFullTs(createdAt)}>
          {formatTs(createdAt)}
        </Text>
        {badge}
        {actions ? (
          <>
            <span className="spacer" />
            {actions}
          </>
        ) : null}
      </Flex>
      <div className="comment-surface">{surface}</div>
    </div>
  );
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
