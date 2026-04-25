import { useState } from 'react';
import { Button, Callout, Checkbox, Flex, Text } from '@radix-ui/themes';
import { Copyable } from './Copyable.js';
import {
  clearSavedPassword,
  saveSavedPassword,
  storePasswordInBrowserPasswordManager,
  supportsBrowserPasswordManager,
  useSavedPassword,
} from '../lib/passwords.js';
import { reportError } from '../lib/log.js';

export function PasswordDisclosureCard({
  docUid,
  password,
  label,
  docName,
}: {
  docUid: string;
  password: string;
  label: string;
  docName?: string | null;
}) {
  const savedPassword = useSavedPassword(docUid);
  const savedOnDevice = savedPassword === password;
  const replacingOlderPassword = !!savedPassword && savedPassword !== password;
  const canStoreInBrowserManager = supportsBrowserPasswordManager();
  const [managerStatus, setManagerStatus] = useState<string | null>(null);
  const [storingInManager, setStoringInManager] = useState(false);

  async function handleBrowserManagerSave() {
    setManagerStatus(null);
    setStoringInManager(true);
    try {
      const stored = await storePasswordInBrowserPasswordManager(docUid, password, docName);
      setManagerStatus(
        stored ? 'Saved in the browser password manager.' : 'Password manager not available here.',
      );
    } catch (err) {
      reportError('PasswordDisclosureCard.browserManager', err, { docUid });
      setManagerStatus('Could not save to the browser password manager.');
    } finally {
      setStoringInManager(false);
    }
  }

  return (
    <Callout.Root color="amber">
      <Callout.Text>
        <Flex direction="column" gap="3">
          <div>
            <Text as="div" size="2" weight="medium" mb="1">
              {label}
            </Text>
            <Copyable text={password} ariaLabel="Copy password" />
          </div>

          <Text as="label" size="2">
            <Flex align="center" gap="2">
              <Checkbox
                checked={savedOnDevice}
                onCheckedChange={(checked) => {
                  if (checked === true) saveSavedPassword(docUid, password);
                  else clearSavedPassword(docUid);
                  setManagerStatus(null);
                }}
              />
              Remember password on this device
            </Flex>
          </Text>

          {replacingOlderPassword && (
            <Text size="1" color="gray">
              Saving this password replaces the older one already stored on this device for this
              document.
            </Text>
          )}

          <Flex align="center" gap="2" wrap="wrap">
            {canStoreInBrowserManager && (
              <Button
                size="1"
                variant="soft"
                disabled={storingInManager}
                onClick={() => void handleBrowserManagerSave()}
              >
                {storingInManager ? 'Saving…' : 'Save in browser password manager'}
              </Button>
            )}
            {savedOnDevice && (
              <Text size="1" color="gray">
                Saved in this browser profile.
              </Text>
            )}
            {managerStatus && (
              <Text size="1" color={managerStatus.startsWith('Saved') ? 'gray' : 'red'}>
                {managerStatus}
              </Text>
            )}
          </Flex>
        </Flex>
      </Callout.Text>
    </Callout.Root>
  );
}
