import { useState } from 'react';
import { Button, Flex, IconButton, TextArea, Tooltip } from '@radix-ui/themes';
import { Pencil2Icon, QuoteIcon } from '@radix-ui/react-icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Comment } from '../lib/api.js';
import { getClientId } from '../lib/identity.js';
import { ConfirmButton } from './ConfirmButton.js';
import { DiscussionEntry } from './DiscussionUi.js';

interface Props {
  comment: Comment;
  isDocAdmin: boolean;
  onEdit: (id: string, body: string) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onQuote?: ((text: string) => void) | undefined;
}

export function CommentItem({ comment, isDocAdmin, onEdit, onDelete, onQuote }: Props) {
  const [editing, setEditing] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const myId = getClientId();
  const isAuthor = comment.author.client_id === myId;
  const actions = !editing ? (
    <Flex gap="1" align="center" wrap="wrap" className="comment-actions comment-actions-inline">
      {!deleteArmed && onQuote && (
        <Tooltip content="Quote">
          <IconButton size="1" variant="ghost" color="gray" aria-label="Quote" onClick={() => onQuote(comment.body)}>
            <QuoteIcon />
          </IconButton>
        </Tooltip>
      )}
      {!deleteArmed && isAuthor && (
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
          reserveWidth={false}
          onArmedChange={setDeleteArmed}
          onConfirm={() => onDelete(comment.id)}
        />
      )}
    </Flex>
  ) : undefined;
  const surface = editing ? (
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
  );

  return (
    <DiscussionEntry
      authorName={comment.author.display_name}
      createdAt={comment.created_at}
      actions={actions}
      surface={surface}
      className={comment.parent_id ? 'reply' : 'top'}
    />
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
