import { UploadIcon } from '@radix-ui/react-icons';
import { Text } from '@radix-ui/themes';
import { useRef, useState } from 'react';

/**
 * Visible pick-or-drop zone: clicking opens the native file picker via a
 * hidden `<input>`; dragging a file over it shows an `--over` state and
 * forwards the drop to `onFile`. Renders as a discoverable dashed panel
 * rather than the browser-default "Choose file" button.
 *
 * Shared so every upload affordance in the app looks and behaves the
 * same — the new-document source/bundle picker and the EPUB cover
 * picker included.
 */
export function FileDropZone({
  accept,
  acceptFile,
  onFile,
  label,
  disabled,
}: {
  /** `accept` attribute for the hidden input — gates the OS picker only. */
  accept: string;
  /**
   * Drag-and-drop filter. The browser bypasses `accept` entirely for
   * drops, so without this an unsupported file would reach `onFile`.
   */
  acceptFile: (file: File) => boolean;
  onFile: (file: File) => void | Promise<void>;
  label: string;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  function openPicker() {
    if (!disabled) inputRef.current?.click();
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: <button> can't host the drag-and-drop and dashed-panel rendering
    <div
      className={`file-drop ${over ? 'file-drop--over' : ''}${disabled ? ' file-drop--disabled' : ''}`}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={openPicker}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openPicker();
        }
      }}
      onDragEnter={(e) => {
        if (disabled || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (disabled || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        depth.current -= 1;
        if (depth.current <= 0) {
          depth.current = 0;
          setOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        if (disabled) return;
        const file = e.dataTransfer.files?.[0];
        if (file && acceptFile(file)) void onFile(file);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        disabled={disabled}
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
          // Reset so re-selecting the same file still fires onChange.
          e.currentTarget.value = '';
        }}
      />
      <UploadIcon width="18" height="18" />
      <Text size="2">{label}</Text>
    </div>
  );
}
