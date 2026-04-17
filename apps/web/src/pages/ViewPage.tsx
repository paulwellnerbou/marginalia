import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getDocument, authenticate, ApiError, type Document } from '../lib/api.js';
import { DocumentLayout } from '../components/DocumentLayout.js';
import { PasswordPrompt } from '../components/PasswordPrompt.js';

export function ViewPage() {
  const { uid } = useParams<{ uid: string }>();
  const [doc, setDoc] = useState<Document | null>(null);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    (async () => {
      try {
        const d = await getDocument(uid);
        if (!cancelled) setDoc(d);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setPasswordRequired(true);
        } else if (err instanceof ApiError && err.status === 404) {
          setError('Document not found');
        } else {
          setError('Failed to load document');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uid]);

  async function handlePassword(password: string) {
    if (!uid) return;
    await authenticate(uid, password);
    setPasswordRequired(false);
    const d = await getDocument(uid);
    setDoc(d);
  }

  if (error) {
    return (
      <div className="page error-page">
        <p>{error}</p>
        <Link to="/">← Home</Link>
      </div>
    );
  }
  if (passwordRequired) {
    return <PasswordPrompt onSubmit={handlePassword} />;
  }
  if (!doc) return <div className="page loading">Loading…</div>;

  return (
    <DocumentLayout doc={doc}>
      <nav className="doc-chrome-right">
        <Link to={`/d/${doc.uid}/edit`} className="chip">
          Edit
        </Link>
      </nav>
    </DocumentLayout>
  );
}
