import { Button, Dialog, Flex, Text } from '@radix-ui/themes';
import { useEffect, useRef, useState } from 'react';
import { reportError } from '../lib/log.js';
import { createQrDetector, type QrDetector } from '../lib/qr-scan.js';

type Status =
  | { phase: 'starting' }
  | { phase: 'scanning'; hint: string | null }
  | { phase: 'failed'; message: string };

/**
 * Camera viewfinder that hands back the first QR code it can read.
 *
 * `onScan` decides whether the text is usable: it returns an error to
 * show while the camera stays on (a wrong code is usually a nearby one,
 * not a reason to give up), or null to say it took the value, at which
 * point the dialog closes itself.
 */
export function QrScanDialog({
  open,
  onOpenChange,
  onScan,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onScan: (text: string) => string | null;
}) {
  // State, not a ref: the dialog's content mounts a render after `open`
  // flips, so an effect keyed on `open` alone would find no element yet.
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<Status>({ phase: 'starting' });
  // Read from the poll loop, which must see the latest handler without
  // restarting the camera on every parent render.
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  useEffect(() => {
    if (!open || !video) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    let detector: QrDetector | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    // Detection can outlast one poll tick; never run two at once.
    let detecting = false;
    // A code sits in front of the camera for many frames after it has
    // been read once. Only the first read counts, and a rejected one is
    // not retried until a different code shows up.
    let lastRejected: string | null = null;

    setStatus({ phase: 'starting' });

    (async () => {
      let decoder: QrDetector;
      try {
        decoder = await createQrDetector();
      } catch (err) {
        if (cancelled) return;
        reportError('qr-scan decoder', err);
        setStatus({ phase: 'failed', message: 'The QR decoder could not be loaded.' });
        return;
      }
      detector = decoder;
      if (cancelled) {
        decoder.close();
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
      } catch (err) {
        if (cancelled) return;
        setStatus({ phase: 'failed', message: cameraErrorMessage(err) });
        return;
      }
      if (cancelled) {
        stopStream(stream);
        return;
      }
      video.srcObject = stream;
      try {
        await video.play();
      } catch (err) {
        // Closing the dialog mid-start aborts play(); that is not a fault.
        if (!cancelled) reportError('qr-scan play', err);
      }
      if (cancelled) return;
      setStatus({ phase: 'scanning', hint: null });

      timer = setInterval(async () => {
        if (detecting || cancelled || video.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) return;
        detecting = true;
        try {
          const text = await decoder.detect(video);
          if (cancelled) return;
          if (!text || text === lastRejected) return;
          const rejection = onScanRef.current(text);
          if (rejection === null) {
            // Accepted once; the parent may take a render to unmount us.
            cancelled = true;
            onOpenChangeRef.current(false);
          } else {
            lastRejected = text;
            setStatus({ phase: 'scanning', hint: rejection });
          }
        } catch (err) {
          // A decoder that throws once will throw every tick; stop rather
          // than log it seven times a second.
          if (cancelled) return;
          cancelled = true;
          clearInterval(timer);
          reportError('qr-scan detect', err);
          setStatus({ phase: 'failed', message: 'The QR decoder failed. Paste the link instead.' });
        } finally {
          detecting = false;
        }
      }, 150);
    })();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
      stopStream(stream);
      detector?.close();
      video.srcObject = null;
    };
  }, [open, video]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="26rem">
        <Dialog.Title>Scan a QR code</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="3">
          Point the camera at the QR code from an access link or a pairing code.
        </Dialog.Description>
        <div className="qr-scan-viewfinder">
          {/* Muted and inline so mobile browsers start it without a tap
              and without leaving the page. */}
          <video ref={setVideo} muted playsInline autoPlay aria-label="Camera preview" />
          {status.phase !== 'scanning' && (
            <Flex className="qr-scan-overlay" align="center" justify="center" p="4">
              <Text size="2" color={status.phase === 'failed' ? 'red' : 'gray'} align="center">
                {status.phase === 'failed' ? status.message : 'Starting the camera…'}
              </Text>
            </Flex>
          )}
        </div>
        {status.phase !== 'failed' && (
          <Text
            size="1"
            color={status.phase === 'scanning' && status.hint ? 'red' : 'gray'}
            as="p"
            mt="2"
            role="status"
            aria-live="polite"
          >
            {status.phase === 'scanning' && status.hint
              ? status.hint
              : 'The code is read as soon as it is in view.'}
          </Text>
        )}
        <Flex justify="end" mt="4">
          <Dialog.Close>
            <Button variant="soft">Cancel</Button>
          </Dialog.Close>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function stopStream(stream: MediaStream | null) {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function cameraErrorMessage(err: unknown): string {
  // Not narrowed to DOMException: OverconstrainedError is its own class,
  // and WebKit reports a device with no camera as exactly that.
  const name = typeof err === 'object' && err !== null && 'name' in err ? String(err.name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was declined. Allow it in the browser settings, or paste the link instead.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
      return 'The camera is in use by another app.';
    default:
      reportError('qr-scan camera', err);
      return 'The camera could not be started.';
  }
}
