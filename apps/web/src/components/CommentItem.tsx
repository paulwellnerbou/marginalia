import { useState } from 'react';
import { Button, Flex, IconButton, Text, TextArea, Tooltip } from '@radix-ui/themes';
import { Pencil2Icon, QuoteIcon } from '@radix-ui/react-icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Comment } from '../lib/api.js';
import { getClientId } from '../lib/identity.js';
import { ConfirmButton } from './ConfirmButton.js';

interface Props {
  comment: Comment;
  isDocAdmin: boolean;
  onEdit: (id: string, body: string) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onQuote?: ((text: string) => void) | undefined;
}

export function CommentItem({ comment, isDocAdmin, onEdit, onDelete, onQuote }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const myId = getClientId();
  const isAuthor = comment.author.client_id === myId;

  return (
    <div className={`comment ${comment.parent_id ? 'reply' : 'top'}`}>
      <Flex align="baseline" gap="2" mb="1" className="comment-meta">
        <Text weight="medium" size="2" className="comment-author">{comment.author.display_name}</Text>
        <Text size="1" color="gray" className="comment-ts" title={formatFullTs(comment.created_at)}>
          {formatTs(comment.created_at)}
        </Text>
        {!editing && (
          <Flex gap="1" align="center" wrap="wrap" className="comment-actions comment-actions-inline">
            <span className="spacer" />
            {onQuote && (
              <Tooltip content="Quote">
                <IconButton size="1" variant="ghost" color="gray" aria-label="Quote" onClick={() => onQuote(comment.body)}>
                  <QuoteIcon />
                </IconButton>
              </Tooltip>
            )}
            {isAuthor && (
              <Tooltip content="Edit">
                <IconButton size="1" variant="ghost" color="gray" aria-label="Edit" onClick={() => setEditing(true)}>
                  <Pencil2Icon />
                </IconButton>
              </Tooltip>
            )}
            {(isAuthor || isDocAdmin) && (
              <ConfirmButton
                label="Delete"
                confirmLabel="Confirm delete"
                ariaLabel="Delete"
                onConfirm={() => onDelete(comment.id)}
              />
            )}
          </Flex>
        )}
      </Flex>
      <div className="comment-surface">
        {editing ? (
          <EditForm
            initial={draft}
            onCancel={() => {
              setEditing(false);
              setDraft(comment.body);
            }}
            onSave={async (v) => {
              await onEdit(comment.id, v);
              setDraft(v);
              setEditing(false);
            }}
          />
        ) : (
          <div className="comment-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{comment.body}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

function EditForm({
  initial,
  onCancel,
  onSave,
}: {
  initial: string;
  onCancel: () => void;
  onSave: (v: string) => Promise<void> | void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className="comment-edit">
      <TextArea
        className="comment-edit-field"
        size="1"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={3}
        autoFocus
      />
      <Flex
        gap="3"
        justify="end"
        align="center"
        wrap="wrap"
        className="comment-actions comment-edit-actions"
      >
        <Button size="1" variant="soft" color="gray" onClick={onCancel}>Cancel</Button>
        <Button size="1" variant="soft" disabled={!value.trim()} onClick={() => onSave(value.trim())}>
          Save
        </Button>
      </Flex>
    </div>
  );
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString();
}

function formatFullTs(ts: number): string {
  return new Date(ts).toLocaleString([], {
    dateStyle: 'full',
    timeStyle: 'medium',
  });
}
