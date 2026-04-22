import { useEffect, useState } from 'react';
import { ActionIcon as IconButton, Modal, Text, Tooltip } from '@mantine/core';
import { Cross2Icon, EnterFullScreenIcon, ExitFullScreenIcon, SunIcon, MoonIcon, TransparencyGridIcon } from '../icons.js';

export interface LightboxImage {
  src: string;
  alt: string;
}

/**
 * A minimal modal-based lightbox. Two zoom modes:
 *
 * - **fit** (default): image centered, sized to fit the viewport with
 *   `object-fit: contain`.
 * - **native**: image at its intrinsic size, scrolls if larger than the
 *   viewport.
 *
 * Click the image (or the toggle button) to cycle; Esc closes via the dialog.
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
    <Modal
      opened={image !== null}
      onClose={onClose}
      keepMounted={false}
      fullScreen
      withCloseButton={false}
      title={<span className="visually-hidden">{image?.alt || 'Image preview'}</span>}
      padding={0}
    >
      <div
        className="lightbox"
        data-bg-mode={bgMode}
        aria-describedby={undefined}
      >
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
                <Text size="xs" c="dimmed" className="lightbox-caption" truncate>
                  {image.alt}
                </Text>
              )}
              <Tooltip label={bgTooltip}>
                <IconButton
                  variant="light"
                  size="sm"
                  color="gray"
                  onClick={cycleBg}
                >
                  <BgIcon />
                </IconButton>
              </Tooltip>
              <Tooltip label={zoom === 'fit' ? 'Actual size' : 'Fit to screen'}>
                <IconButton
                  variant="light"
                  size="sm"
                  color="gray"
                  onClick={(e: any) => {
                    e.stopPropagation();
                    setZoom((z) => (z === 'fit' ? 'native' : 'fit'));
                  }}
                >
                  {zoom === 'fit' ? <EnterFullScreenIcon /> : <ExitFullScreenIcon />}
                </IconButton>
              </Tooltip>
              <Tooltip label="Close">
                <IconButton variant="light" size="sm" color="gray" onClick={onClose}>
                  <Cross2Icon />
                </IconButton>
              </Tooltip>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
