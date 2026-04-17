import type { TocNode } from '../lib/api.js';

export function Toc({ nodes }: { nodes: TocNode[] }) {
  if (nodes.length === 0) return <div className="toc-empty subtle">No headings</div>;
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
        <li key={n.id} className={`toc-l${n.level}`}>
          <a href={`#${n.id}`}>{n.text}</a>
          {n.children.length > 0 && <TocList nodes={n.children} />}
        </li>
      ))}
    </ul>
  );
}
