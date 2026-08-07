import { Button, Container, Flex, Heading, Text } from '@radix-ui/themes';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportError } from '../lib/log.js';

interface Props {
  children: ReactNode;
}

interface State {
  error: unknown;
}

/**
 * A route's code is lazily imported, and a rejected import unmounts the
 * whole tree — the user gets a blank page with the reason only in the
 * console. That happens offline, and also when a deploy replaces the
 * hashed bundles under an already-open tab.
 */
export class RouteErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    reportError('route', error, { componentStack: info.componentStack });
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const chunkFailed = isChunkLoadError(error);
    return (
      <Container size="2" py="8">
        <Flex direction="column" gap="3" align="start">
          <Heading size="4">
            {chunkFailed ? "This page didn't load" : 'Something went wrong'}
          </Heading>
          <Text color="gray" size="2">
            {chunkFailed
              ? 'Part of the app could not be fetched. You may be offline, or a new version was deployed while this tab was open.'
              : 'The page hit an unexpected error. The details are in the browser console.'}
          </Text>
          <Button onClick={() => window.location.reload()}>Reload</Button>
        </Flex>
      </Container>
    );
  }
}

/** Browsers word this differently; match on what each of them actually throws. */
function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|Importing a module script failed|ChunkLoadError|error loading dynamically imported module/i.test(
    message,
  );
}
