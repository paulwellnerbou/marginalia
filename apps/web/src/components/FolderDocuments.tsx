import { FileTextIcon, PlusIcon, ReaderIcon } from '@radix-ui/react-icons';
import { Link } from 'react-router-dom';
import type { DocumentFolder, FolderDocument } from '../lib/api.js';

interface Props {
  folder: DocumentFolder;
  currentUid: string;
  /** The open document's live title, which may be newer than the listing's. */
  currentTitle: string;
  /** Present for readers allowed to add a document here. */
  onAdd?: (() => void) | undefined;
}

/**
 * The documents that belong together, above the open document's contents:
 * the main document as the entry, the rest beneath it. No "folder" label —
 * the main document's title says what they belong to.
 */
export function FolderDocuments({ folder, currentUid, currentTitle, onAdd }: Props) {
  const main = folder.documents.find((d) => d.main);
  const companions = folder.documents.filter((d) => !d.main);
  const titleOf = (d: FolderDocument) =>
    d.uid === currentUid ? currentTitle : (d.title ?? 'Untitled');

  return (
    <nav
      className="folder-docs"
      aria-label={main ? `Documents that belong with ${titleOf(main)}` : 'Documents'}
    >
      <ul className="folder-docs-list">
        {main && (
          <li>
            <FolderLink doc={main} title={titleOf(main)} current={main.uid === currentUid} />
            {companions.length > 0 && (
              <ul className="folder-docs-list folder-docs-companions">
                {companions.map((d) => (
                  <li key={d.uid}>
                    <FolderLink doc={d} title={titleOf(d)} current={d.uid === currentUid} />
                  </li>
                ))}
              </ul>
            )}
          </li>
        )}
      </ul>
      {onAdd && (
        <button type="button" className="folder-docs-row folder-docs-add" onClick={onAdd}>
          <PlusIcon aria-hidden />
          <span>Add a document</span>
        </button>
      )}
    </nav>
  );
}

function FolderLink({
  doc,
  title,
  current,
}: {
  doc: FolderDocument;
  title: string;
  current: boolean;
}) {
  const Icon = doc.main ? ReaderIcon : FileTextIcon;
  return (
    <Link
      to={`/d/${doc.uid}`}
      className={`folder-docs-row${doc.main ? ' folder-docs-main' : ''}${current ? ' active' : ''}`}
      aria-current={current ? 'page' : undefined}
      title={title}
    >
      <Icon aria-hidden />
      <span className="folder-docs-title">{title}</span>
    </Link>
  );
}
