import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ensureIdentity } from '../lib/identity.js';
import { uploadDocument, ApiError } from '../lib/api.js';

const SAMPLE = `# Welcome

This is a markdown document. Edit me, then save.

## Features

- Tables, images, mermaid diagrams, syntax-highlighted code
- In-document references that work with Unicode headings
- Commenting (coming in Phase 5)

\`\`\`ts
console.log('hello');
\`\`\`
`;

export function HomePage() {
  const navigate = useNavigate();
  const [markdown, setMarkdown] = useState(SAMPLE);
  const [passwordProtected, setPasswordProtected] = useState(false);
  const [editableByAnyone, setEditableByAnyone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadedPassword, setUploadedPassword] = useState<string | null>(null);
  const [uploadedRecovery, setUploadedRecovery] = useState<string | null>(null);

  async function handleFile(file: File) {
    const text = await file.text();
    setMarkdown(text);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const identity = ensureIdentity();
    if (!identity) {
      setError('A display name is required to upload.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await uploadDocument(
        {
          markdown,
          password_protected: passwordProtected,
          editable_by_anyone: editableByAnyone,
        },
        identity,
      );
      if (res.password) {
        setUploadedPassword(res.password);
        setUploadedRecovery(res.admin_recovery_token);
        // Don't navigate yet — show the password once.
        sessionStorage.setItem(`markdowner.uid.${res.uid}`, res.uid);
      } else {
        navigate(`/d/${res.uid}`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.code}` : 'Upload failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (uploadedPassword) {
    return (
      <div className="page home">
        <div className="panel">
          <h1>Document created</h1>
          <p>
            Your document is password-protected. <strong>Save these now</strong> —
            they are only shown once:
          </p>
          <dl className="keyvals">
            <dt>Password</dt>
            <dd>
              <code>{uploadedPassword}</code>
            </dd>
            <dt>Admin recovery token</dt>
            <dd>
              <code>{uploadedRecovery}</code>
            </dd>
          </dl>
          <button className="primary" onClick={() => navigate('/d/' + sessionKey())}>
            Open the document
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page home">
      <form className="panel" onSubmit={handleSubmit}>
        <h1>Markdowner</h1>
        <p className="subtle">
          Upload a Markdown document. It gets its own URL, tracked in git,
          rendered with a theme you can change later.
        </p>

        <label className="field">
          <span>Markdown source</span>
          <textarea
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            rows={18}
            spellCheck={false}
          />
        </label>

        <label className="field inline">
          <input
            type="file"
            accept=".md,.markdown,text/markdown"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
          />
          <span>…or load a .md file</span>
        </label>

        <fieldset className="field">
          <legend>Visibility</legend>
          <label className="check">
            <input
              type="checkbox"
              checked={passwordProtected}
              onChange={(e) => setPasswordProtected(e.target.checked)}
            />
            <span>Password-protect (server generates a password, shown once)</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={editableByAnyone}
              onChange={(e) => setEditableByAnyone(e.target.checked)}
            />
            <span>Allow anyone (with access) to edit the source</span>
          </label>
        </fieldset>

        {error && <p className="error">{error}</p>}

        <button type="submit" className="primary" disabled={submitting || !markdown}>
          {submitting ? 'Uploading…' : 'Create document'}
        </button>
      </form>
    </div>
  );
}

function sessionKey(): string {
  const keys = Object.keys(sessionStorage).filter((k) => k.startsWith('markdowner.uid.'));
  const last = keys[keys.length - 1];
  return last ? sessionStorage.getItem(last)! : '';
}
