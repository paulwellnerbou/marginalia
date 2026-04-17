import { useState } from 'react';
import { Box, Button, Callout, Container, Flex, Heading, Text, TextField } from '@radix-ui/themes';
import { ApiError } from '../lib/api.js';
import { reportError } from '../lib/log.js';

export function PasswordPrompt({ onSubmit }: { onSubmit: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handle(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(password);
    } catch (err) {
      reportError('PasswordPrompt.submit', err);
      if (err instanceof ApiError && err.status === 401) setError('Wrong password');
      else setError('Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Container size="1" py="8">
      <Box className="panel" asChild>
        <form onSubmit={handle}>
          <Heading size="6" mb="2">Password required</Heading>
          <Text as="p" color="gray" mb="4">This document is password-protected.</Text>
          <Flex direction="column" gap="3">
            <TextField.Root
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoFocus
            />
            {error && (
              <Callout.Root color="red" size="1">
                <Callout.Text>{error}</Callout.Text>
              </Callout.Root>
            )}
            <Button type="submit" size="3" disabled={submitting || !password}>
              {submitting ? 'Checking…' : 'Unlock'}
            </Button>
          </Flex>
        </form>
      </Box>
    </Container>
  );
}
