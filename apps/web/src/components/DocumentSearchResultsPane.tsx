import { Box, Button, Flex, Text } from '@mantine/core';
import { APP_ACCENT_COLOR } from '../styles/theme.js';

export interface DocumentSearchResult {
  id: string;
  index: number;
  text: string;
  contextBefore: string;
  contextAfter: string;
  blockId: string | null;
  headingId: string | null;
}

interface Props {
  query: string;
  results: DocumentSearchResult[];
  activeResultId: string | null;
  onSelectResult: (id: string) => void;
}

export function DocumentSearchResultsPane({
  query,
  results,
  activeResultId,
  onSelectResult,
}: Props) {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    return (
      <Box p="3">
        <Text size="xs" c="dimmed">
          Type in document search to see matching results here.
        </Text>
      </Box>
    );
  }

  if (results.length === 0) {
    return (
      <Box p="3">
        <Text size="xs" c="dimmed">
          No matches for "{trimmedQuery}".
        </Text>
      </Box>
    );
  }

  return (
    <Flex direction="column" gap="2" p="3" className="doc-search-results-list">
      {results.map((result) => {
        const active = result.id === activeResultId;
        return (
          <Button
            key={result.id}
            type="button"
            variant={active ? 'light' : 'subtle'}
            color={active ? APP_ACCENT_COLOR : 'gray'}
            className={`doc-search-result ${active ? 'active' : ''}`}
            onClick={() => onSelectResult(result.id)}
          >
            <Flex direction="column" align="start" gap="1">
              <Flex align="center" gap="2">
                <Text size="xs" c="dimmed">
                  {result.index + 1}
                </Text>
                {result.headingId && (
                  <Text size="xs" c="dimmed" className="doc-search-result-heading">
                    #{result.headingId}
                  </Text>
                )}
              </Flex>
              <Text size="sm" className="doc-search-result-snippet">
                {result.contextBefore && (
                  <span className="doc-search-result-context">{result.contextBefore}</span>
                )}
                <mark className="doc-search-result-hit">{result.text}</mark>
                {result.contextAfter && (
                  <span className="doc-search-result-context">{result.contextAfter}</span>
                )}
              </Text>
            </Flex>
          </Button>
        );
      })}
    </Flex>
  );
}
