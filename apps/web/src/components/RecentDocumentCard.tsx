import {
  ActionIcon as IconButton,
  Badge,
  Box,
  Card,
  Flex,
  Text,
  Tooltip,
} from '@mantine/core';
import { Cross2Icon, FileTextIcon, LockClosedIcon } from '../icons.js';
import type { RecentDoc } from '../lib/recent-docs.js';
import { appRoleColor } from '../styles/theme.js';
import { FormatBadge } from './FormatBadge.js';
import './RecentDocumentCard.css';

function recentFormatSummary(format: RecentDoc['format']) {
  return format === 'asciidoc' ? 'AsciiDoc document' : 'Markdown document';
}

function recentRoleSummary(role: RecentDoc['role']) {
  switch (role) {
    case 'admin':
      return 'Admin access';
    case 'editor':
      return 'Editor access';
    case 'collaborator':
      return 'Collaborator access';
    default:
      return 'Read-only access';
  }
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / (60 * 60_000))}h ago`;
  return new Date(ts).toLocaleDateString();
}

function formatFullTs(ts: number): string {
  return new Date(ts).toLocaleString([], {
    dateStyle: 'full',
    timeStyle: 'medium',
  });
}

export function RecentDocumentCard({
  doc,
  onOpen,
  onRemove,
}: {
  doc: RecentDoc;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const updatedSinceVisit = doc.updated_at > doc.visited_at;

  return (
    <Card p="0" className="recent-card" data-format={doc.format} onClick={onOpen}>
      <Flex direction="column" className="recent-card-body">
        <Flex justify="between" align="start" gap="3" className="recent-card-header">
          <Flex gap="3" align="start" className="recent-card-main">
            <Box className="recent-card-icon">
              <FileTextIcon />
            </Box>
            <Box className="recent-card-copy">
              <Text size="xs" c="dimmed" component="div" className="recent-card-meta">
                {recentFormatSummary(doc.format)} • {recentRoleSummary(doc.role)}
              </Text>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen();
                }}
                className="recent-card-title"
              >
                <Text component="span" size="lg" fw={500} className="recent-card-title-text">
                  {doc.title}
                </Text>
              </button>
            </Box>
          </Flex>
          <Tooltip label="Remove from recent">
            <IconButton
              variant="subtle"
              size="sm"
              color="gray"
              className="recent-card-remove"
              aria-label="Remove from recent"
              onClick={(e: any) => {
                e.stopPropagation();
                onRemove();
              }}
            >
              <Cross2Icon />
            </IconButton>
          </Tooltip>
        </Flex>

        <Flex gap="2" wrap="wrap" align="center" className="recent-card-badges">
          <FormatBadge format={doc.format} />
          <Badge
            variant="light"
            color={appRoleColor(doc.role)}
            size="xs"
            className="role-badge"
          >
            {doc.role}
          </Badge>
        </Flex>

        <Flex justify="between" align="center" gap="3" className="recent-card-footer">
          <Text
            size="xs"
            c="dimmed"
            component="div"
            title={formatFullTs(doc.visited_at)}
            className="recent-card-timestamp"
          >
            Last opened {formatRelative(doc.visited_at)}
          </Text>
          {(doc.password_protected || updatedSinceVisit) && (
            <Flex gap="3" align="center" wrap="wrap" className="recent-card-footer-meta">
              {doc.password_protected && (
                <span className="recent-card-status recent-card-status--locked">
                  <LockClosedIcon />
                  <span>Locked</span>
                </span>
              )}
              {updatedSinceVisit && (
                <span className="recent-card-status recent-card-status--new">
                  <span className="recent-card-status-dot" />
                  <span>Updated</span>
                </span>
              )}
            </Flex>
          )}
        </Flex>
      </Flex>
    </Card>
  );
}
