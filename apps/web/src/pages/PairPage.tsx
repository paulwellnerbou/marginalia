import { CheckCircledIcon } from '@radix-ui/react-icons';
import { Button, Callout, Container, Flex, Heading, Text, TextField } from '@radix-ui/themes';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AppBar } from '../components/AppBar.js';
import { pairWithCode } from '../lib/keyring.js';
import { reportError } from '../lib/log.js';
import { redeemErrorMessage } from '../lib/pairing-error.js';

type State =
  | { phase: 'entering'; error: string | null }
  | { phase: 'redeeming' }
  | { phase: 'done'; count: number };

/**
 * Lands a device on the other end of a pairing code — scanned from the
 * QR, or typed in by hand when a camera isn't the convenient path.
 *
 * Reachable at `/k/:code` and at bare `/k`. The QR carries the code in
 * the URL and redeems on arrival; `/k` is the landing spot for a code
 * typed by hand, which an installed PWA on iOS needs because it opens in
 * its own storage container and a scan lands in the browser's instead.
 *
 * Typing is also offered inline on the home page (`DeviceSyncPanel`), so
 * nobody has to know this URL to get here.
 */
export function PairPage() {
  const { code: codeFromUrl } = useParams<{ code?: string }>();
  const navigate = useNavigate();
  const [code, setCode] = useState(codeFromUrl ?? '');
  const [state, setState] = useState<State>(
    codeFromUrl ? { phase: 'redeeming' } : { phase: 'entering', error: null },
  );
  // A code is single-use, so a re-render (or React 19 StrictMode's double
  // effect in development) must not spend it twice — the second attempt
  // would 404 and report a working code as invalid.
  //
  // Keyed by the code rather than a bare "have we tried" flag: React
  // Router reuses this component across /k/:code navigations, so a
  // boolean would make every code after the first a silent no-op.
  const attempted = useRef<string | null>(null);
  // `attempted` covers the effect; this covers the button. The redeeming
  // phase disables it, but only from the next render, so two submits in
  // one tick would both get through and spend the code twice.
  const inFlight = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: redeem is redeclared each render, so listing it would re-fire the effect and spend a second code. The `attempted` guard is what makes redemption once-only; codeFromUrl is the real trigger.
  useEffect(() => {
    if (!codeFromUrl || attempted.current === codeFromUrl) return;
    attempted.current = codeFromUrl;
    void redeem(codeFromUrl);
  }, [codeFromUrl]);

  async function redeem(raw: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setState({ phase: 'redeeming' });
    try {
      const docs = await pairWithCode(raw.trim());
      // Strip the code from the address bar. It is spent, so this is
      // tidiness rather than secrecy — but a spent code left in history
      // is a confusing thing to re-open later.
      window.history.replaceState({}, '', '/k');
      setState({ phase: 'done', count: docs.length });
    } catch (err) {
      reportError('PairPage.redeem', err);
      setState({ phase: 'entering', error: redeemErrorMessage(err) });
    } finally {
      inFlight.current = false;
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!code.trim()) return;
    void redeem(code);
  }

  if (state.phase === 'done') {
    return (
      <>
        <AppBar />
        <Container size="2" px="4" py="8">
          <Callout.Root color="green" mb="4">
            <Callout.Icon>
              <CheckCircledIcon />
            </Callout.Icon>
            <Callout.Text>
              This device is now syncing.{' '}
              {state.count === 1 ? '1 document is' : `${state.count} documents are`} available here.
            </Callout.Text>
          </Callout.Root>
          <Button onClick={() => navigate('/')}>Go to your documents</Button>
        </Container>
      </>
    );
  }

  return (
    <>
      <AppBar />
      <Container size="2" px="4" py="8">
        <Heading size="6" mb="2">
          Add this device
        </Heading>
        <Text size="2" color="gray" as="p" mb="4">
          On a device that already has your documents, open the home page and choose{' '}
          <strong>Add a device</strong>. Enter the code it shows here.
        </Text>

        <form onSubmit={submit}>
          <Flex gap="2" align="start" wrap="wrap">
            <TextField.Root
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
                if (state.phase === 'entering' && state.error) {
                  setState({ phase: 'entering', error: null });
                }
              }}
              placeholder="ABCD-EFGH"
              aria-label="Pairing code"
              size="3"
              spellCheck={false}
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="one-time-code"
              disabled={state.phase === 'redeeming'}
              style={{ flex: '1 1 14rem', fontFamily: 'var(--code-font-family)' }}
            />
            <Button type="submit" size="3" loading={state.phase === 'redeeming'}>
              Pair
            </Button>
          </Flex>
        </form>

        {state.phase === 'entering' && state.error && (
          <Callout.Root color="red" size="1" mt="3">
            <Callout.Text>{state.error}</Callout.Text>
          </Callout.Root>
        )}
      </Container>
    </>
  );
}
