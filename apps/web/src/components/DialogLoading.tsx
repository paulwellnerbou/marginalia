import { Flex, Spinner, Text } from '@radix-ui/themes';

/**
 * Fetching a diff can take many seconds on a large document, and a
 * motionless line of text there reads as a hung dialog. `role="status"`
 * announces the label once, without interrupting.
 */
export function DialogLoading({ children }: { children: React.ReactNode }) {
  return (
    <Flex role="status" align="center" gap="2" py="4">
      <Spinner size="2" />
      <Text color="gray" size="2">
        {children}
      </Text>
    </Flex>
  );
}
