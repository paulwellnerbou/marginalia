import { Text } from '@radix-ui/themes';

/**
 * Fetching a diff can take many seconds on a large document, and a
 * motionless line of text there reads as a hung dialog. The ring is
 * decorative — hidden from assistive tech so `role="status"` announces
 * the label alone, once, without interrupting.
 */
export function DialogLoading({ children }: { children: React.ReactNode }) {
  return (
    <Text role="status" as="p" color="gray" size="2" my="4">
      <span className="ic-spinner" aria-hidden="true" /> {children}
    </Text>
  );
}
