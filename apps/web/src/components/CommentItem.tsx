import { useState } from 'react';
import { Button, Flex, Text, TextArea } from '@radix-ui/themes';
import type { Comment } from '../lib/api.js';
import { getClientId } from '../lib/identity.js';
import { ConfirmButton } from './ConfirmButton.js';

interface Props {
  comment: Comment;
  isDocAdmin: boolean;
  onEdit: (id: string, body: string) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onReply?: ((parentId: string) => void) | undefined;
}

export function CommentItem({ comment, isDocAdmin, onEdit, onDelete, onReply }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const myId = getClientId();
  const isAuthor = comment.author.client_id === myId;

  return (
    <div className={`comment ${comment.parent_id ? 'reply' : 'top'}`}>
      <Flex align="baseline" gap="2" mb="1">
        <Text weight="medium" size="2">{comment.author.display_name}</Text>
        <Text size="1" color="gray">{formatTs(comment.created_at)}</Text>
      </Flex>
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
        <Text as="p" className="comment-body">{comment.body}</Text>
      )}
      {!editing && (
        <Flex gap="2" mt="1" align="center">
          {onReply && !comment.parent_id && (
            <Button size="1" variant="ghost" onClick={() => onReply(comment.id)}>
              Reply
            </Button>
          )}
          {isAuthor && (
            <Button size="1" variant="ghost" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          {(isAuthor || isDocAdmin) && (
            <ConfirmButton
              label="Delete"
              confirmLabel="Confirm delete"
              onConfirm={() => onDelete(comment.id)}
            />
          )}
        </Flex>
      )}
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
        size="1"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={3}
        autoFocus
      />
      <Flex gap="2" mt="1">
        <Button size="1" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="1" disabled={!value.trim()} onClick={() => onSave(value.trim())}>
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
