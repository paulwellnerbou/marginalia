import { useState } from 'react';
import { IconButton, Text } from '@radix-ui/themes';
import { ChevronDownIcon, ChevronRightIcon } from '@radix-ui/react-icons';
import type { TocNode } from '../lib/api.js';

export function Toc({ nodes }: { nodes: TocNode[] }) {
  if (nodes.length === 0) return <Text size="1" color="gray" className="toc-empty">No headings</Text>;
  return (
    <nav className="toc">
      <TocList nodes={nodes} />
    </nav>
  );
}

function TocList({ nodes }: { nodes: TocNode[] }) {
  return (
    <ul className="toc-list">
      {nodes.map((n) => (
        <TocItem key={n.id} node={n} />
      ))}
    </ul>
  );
}

function TocItem({ node }: { node: TocNode }) {
  const hasChildren = node.children.length > 0;
  const [open, setOpen] = useState(true);

  return (
    <li className={`toc-item toc-l${node.level}`}>
      <div className="toc-row">
        {hasChildren ? (
          <IconButton
            size="1"
            variant="ghost"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? 'Collapse' : 'Expand'}
            className="toc-toggle"
          >
            {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </IconButton>
        ) : (
          <span className="toc-toggle-spacer" aria-hidden />
        )}
        <a href={`#${node.id}`}>{node.text}</a>
      </div>
      {hasChildren && open && <TocList nodes={node.children} />}
    </li>
  );
}
