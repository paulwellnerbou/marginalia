import { useEffect, useState } from 'react';
import { Dialog, IconButton, Text, Tooltip } from '@radix-ui/themes';
import { Cross2Icon, EnterFullScreenIcon, ExitFullScreenIcon, SunIcon, MoonIcon, TransparencyGridIcon } from '@radix-ui/react-icons';

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
 * Click the image (or the toggle button) to cycle; Esc closes via Radix.
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

  // Reset zoom whenever a new image is opened.
  useEffect(() => {
    if (image) setZoom('fit');
  }, [image]);

  const cycleBg = (e: React.MouseEvent) => {
    e.stopPropagation();
    setBgMode((b) => (b === 'dark' ? 'light' : b === 'light' ? 'checker' : 'dark'));
  };



  const BgIcon = bgMode === 'dark' ? SunIcon : bgMode === 'light' ? TransparencyGridIcon : MoonIcon;
  const bgTooltip = bgMode === 'dark' ? 'Light background' : bgMode === 'light' ? 'Checkerboard background' : 'Dark background';

  return (
    <Dialog.Root open={image !== null} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Content
        className="lightbox"
        data-bg-mode={bgMode}
        maxWidth="100vw"
        size="1"
        aria-describedby={undefined}
      >
        <Dialog.Title className="visually-hidden">
          {image?.alt || 'Image preview'}
        </Dialog.Title>
        {image && (
          <>
            <div
              className={`lightbox-stage lightbox-stage-${zoom}`}
              onClick={() => setZoom((z) => (z === 'fit' ? 'native' : 'fit'))}
            >
              <div className={`lightbox-media zoom-${zoom}`}>
                <img src={image.src} alt={image.alt} className={`lightbox-img zoom-${zoom}`} />
              </div>
            </div>
            <div className="lightbox-controls">
              {image.alt && (
                <Text size="1" color="gray" className="lightbox-caption" truncate>
                  {image.alt}
                </Text>
              )}
              <Tooltip content={bgTooltip}>
                <IconButton
                  variant="soft"
                  size="2"
                  color="gray"
                  onClick={cycleBg}
                >
                  <BgIcon />
                </IconButton>
              </Tooltip>
              <Tooltip content={zoom === 'fit' ? 'Actual size' : 'Fit to screen'}>
                <IconButton
                  variant="soft"
                  size="2"
                  color="gray"
                  onClick={(e) => {
                    e.stopPropagation();
                    setZoom((z) => (z === 'fit' ? 'native' : 'fit'));
                  }}
                >
                  {zoom === 'fit' ? <EnterFullScreenIcon /> : <ExitFullScreenIcon />}
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
          </>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}
