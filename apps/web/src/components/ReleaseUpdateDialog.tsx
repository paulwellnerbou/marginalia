import { AlertDialog, Button, Code, Flex, Text } from '@radix-ui/themes';
import { useCallback, useEffect, useRef, useState } from 'react';

const RELEASE_CHECK_INTERVAL_MS = 60_000;

function normalizeReleaseVersion(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 7).toLowerCase() : '';
}

/**
 * Watches the deployment version independently of document traffic. The
 * version baked into this JavaScript bundle is the baseline; `/api/version`
 * identifies the server currently answering requests.
 */
export function ReleaseUpdateDialog() {
  const initialRelease = normalizeReleaseVersion(import.meta.env.VITE_RELEASE_VERSION);
  const currentReleaseRef = useRef(initialRelease);
  const dismissedReleaseRef = useRef('');
  const [availableRelease, setAvailableRelease] = useState('');

  const checkForUpdate = useCallback(async () => {
    try {
      const response = await fetch('/api/version', { cache: 'no-store' });
      if (!response.ok) return;
      const payload = (await response.json()) as { releaseVersion?: unknown };
      const latestRelease = normalizeReleaseVersion(payload.releaseVersion);
      if (!latestRelease) return;

      if (!currentReleaseRef.current) {
        // Local/dev builds may not have a release baked in. Establishing a
        // baseline keeps them useful without presenting every startup as an
        // update.
        currentReleaseRef.current = latestRelease;
        return;
      }
      if (
        latestRelease === currentReleaseRef.current ||
        latestRelease === dismissedReleaseRef.current
      ) {
        return;
      }
      setAvailableRelease(latestRelease);
    } catch {
      // Losing the version probe must not interfere with the editor. A later
      // poll, focus, or return to the tab will try again.
    }
  }, []);

  useEffect(() => {
    let active = true;
    const run = () => {
      if (active) void checkForUpdate();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') run();
    };

    run();
    const interval = window.setInterval(run, RELEASE_CHECK_INTERVAL_MS);
    window.addEventListener('focus', run);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', run);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [checkForUpdate]);

  const chooseLater = useCallback(() => {
    dismissedReleaseRef.current = availableRelease;
    setAvailableRelease('');
  }, [availableRelease]);

  const refresh = useCallback(() => {
    window.location.reload();
  }, []);

  return (
    <AlertDialog.Root
      open={availableRelease.length > 0}
      onOpenChange={(open) => {
        if (!open) chooseLater();
      }}
    >
      <AlertDialog.Content maxWidth="480px">
        <AlertDialog.Title>New version available</AlertDialog.Title>
        <AlertDialog.Description size="2">
          A new Marginalia version has been released. Refresh the app to start using it.
        </AlertDialog.Description>
        <Text as="p" size="2" color="gray" mt="3">
          If you have text that is not saved yet, choose Later so you can copy it before refreshing.
        </Text>
        <Text as="p" size="1" color="gray" mt="2">
          Release <Code size="1">{availableRelease}</Code>
        </Text>
        <Flex gap="2" justify="end" mt="4">
          <AlertDialog.Cancel>
            <Button variant="soft" color="gray" onClick={chooseLater}>
              Later
            </Button>
          </AlertDialog.Cancel>
          <AlertDialog.Action>
            <Button onClick={refresh}>Refresh now</Button>
          </AlertDialog.Action>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
