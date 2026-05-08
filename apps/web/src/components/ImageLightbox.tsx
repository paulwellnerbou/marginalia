import { Cross2Icon, MoonIcon, SunIcon, TransparencyGridIcon } from '@radix-ui/react-icons';
import { Dialog, IconButton, Tooltip } from '@radix-ui/themes';
import { useEffect, useState } from 'react';

export interface LightboxImage {
  src: string;
  alt: string;
}

/**
 * A minimal Radix-Dialog-based lightbox. Two zoom modes:
 *
 * - **fit** (default): image centered, sized to fit the viewport with
 *   `object-fit: contain`.
 * - **native**: image at its intrinsic size, scrolls if larger than the
 *   viewport.
 *
 * Click the image to toggle zoom; Esc closes via Radix.
 */
export function ImageLightbox({
  image,
  onClose,
}: {
  image: LightboxImage | null;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState<'fit' | 'native'>('fit');
  const [bgMode, setBgMode] = useState<'dark' | 'light' | 'checker'>('dark');

  useEffect(() => {
    if (image) setZoom('fit');
  }, [image]);

  const cycleBg = () => {
    setBgMode((b) => (b === 'dark' ? 'light' : b === 'light' ? 'checker' : 'dark'));
  };

  const BgIcon = bgMode === 'dark' ? SunIcon : bgMode === 'light' ? TransparencyGridIcon : MoonIcon;
  const bgTooltip =
    bgMode === 'dark'
      ? 'Light background'
      : bgMode === 'light'
        ? 'Checkerboard background'
        : 'Dark background';

  return (
    <Dialog.Root open={image !== null} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Content
        className="lightbox"
        data-bg-mode={bgMode}
        maxWidth="100vw"
        size="1"
        aria-describedby={undefined}
      >
        <Dialog.Title className="visually-hidden">{image?.alt || 'Image preview'}</Dialog.Title>
        {image && (
          // biome-ignore lint/a11y/useSemanticElements: <button> cannot contain the controls and image markup inside
          <div
            className={`lightbox-stage lightbox-stage-${zoom}`}
            role="button"
            tabIndex={0}
            aria-label={zoom === 'fit' ? 'Zoom to native size' : 'Fit to viewport'}
            onClick={() => setZoom((z) => (z === 'fit' ? 'native' : 'fit'))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setZoom((z) => (z === 'fit' ? 'native' : 'fit'));
              }
            }}
          >
            <div className="lightbox-figure">
              {/* biome-ignore lint/a11y/noStaticElementInteractions: stop-propagation only — controls inside are buttons */}
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: stop-propagation only, no real interaction */}
              <div className="lightbox-controls" onClick={(e) => e.stopPropagation()}>
                <Tooltip content={bgTooltip}>
                  <IconButton variant="soft" size="2" color="gray" onClick={cycleBg}>
                    <BgIcon />
                  </IconButton>
                </Tooltip>
                <Tooltip content="Close">
                  <Dialog.Close>
                    <IconButton variant="soft" size="2" color="gray">
                      <Cross2Icon />
                    </IconButton>
                  </Dialog.Close>
                </Tooltip>
              </div>
              <div className={`lightbox-media zoom-${zoom}`}>
                <img src={image.src} alt={image.alt} className={`lightbox-img zoom-${zoom}`} />
              </div>
              {image.alt && (
                // biome-ignore lint/a11y/useKeyWithClickEvents: stop-propagation only, no real interaction
                <p className="lightbox-caption" onClick={(e) => e.stopPropagation()}>
                  {image.alt}
                </p>
              )}
            </div>
          </div>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}
