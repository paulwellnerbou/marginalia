import { useCallback, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Thread } from '../../lib/api.js';
import {
  describeThreadRef,
  parseThreadRefHref,
  rehypeThreadRefs,
  type ThreadRefApi,
} from './threadRefs.js';

interface Props {
  children: string;
  threadRefs: ThreadRefApi;
}

export function InlineCommentMarkdown({ children, threadRefs }: Props) {
  // A thread whose anchor is gone has nowhere to scroll to, so its id
  // stays plain text instead of becoming a link that does nothing.
  const target = useCallback(
    (id: string): Thread | null => {
      const thread = threadRefs.resolve(id);
      return thread?.anchor.block_id ? thread : null;
    },
    [threadRefs],
  );

  const rehypePlugins = useMemo(() => [rehypeThreadRefs((id) => target(id) !== null)], [target]);

  const components = useMemo<Components>(
    () => ({
      a(props) {
        const { node: _node, href, children: label, ...rest } = props;
        const id = href ? parseThreadRefHref(href) : null;
        const thread = id ? target(id) : null;
        if (!thread) {
          return (
            <a href={href} {...rest}>
              {label}
            </a>
          );
        }
        return (
          <a
            href={href}
            className="ic-thread-ref"
            title={describeThreadRef(thread)}
            onClick={(event) => {
              event.preventDefault();
              threadRefs.focus(thread);
            }}
          >
            {label}
          </a>
        );
      },
    }),
    [target, threadRefs],
  );

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={rehypePlugins}
      components={components}
    >
      {children}
    </ReactMarkdown>
  );
}
