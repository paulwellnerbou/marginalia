import { CheckIcon } from '@radix-ui/react-icons';
import {
  Badge,
  Box,
  Button,
  Callout,
  Flex,
  SegmentedControl,
  Text,
  TextField,
} from '@radix-ui/themes';
import { useCallback, useEffect, useState } from 'react';
import { createInvite, type Invite, listInvites } from '../lib/api.js';
import { getClientId, getDisplayName } from '../lib/identity.js';
import { reportError } from '../lib/log.js';
import { Copyable } from './Copyable.js';

interface Props {
  uid: string;
  /** Only an admin can mint the agent's access link. */
  canManageInvites: boolean;
}

type Setup = 'cli' | 'json';

const DEFAULT_AGENT_NAME = 'Claude';

/**
 * "Connect an agent" — the two things a user has to do, in order.
 *
 * Access first, because an agent with no invite is a reader and every
 * write it attempts fails; then the connection string, which is just
 * this instance's `/mcp` URL. Nothing is installed and nothing runs
 * locally, so there is no third step.
 */
export function McpPanel({ uid, canManageInvites }: Props) {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [agentName, setAgentName] = useState(DEFAULT_AGENT_NAME);
  const [setup, setSetup] = useState<Setup>('cli');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!canManageInvites) return;
    try {
      const res = await listInvites(uid);
      setInvites(res.invites);
    } catch (err) {
      reportError('McpPanel.listInvites', err);
      setInvites([]);
    }
  }, [uid, canManageInvites]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Any non-admin, non-reader link works for an agent; showing the ones
  // that already exist saves minting a duplicate on every visit.
  const agentInvites = (invites ?? []).filter(
    (i) => i.kind !== 'admin' && (i.role === 'collaborator' || i.role === 'editor'),
  );

  async function mint() {
    setCreating(true);
    setError(null);
    try {
      const name = agentName.trim() || DEFAULT_AGENT_NAME;
      await createInvite(
        uid,
        { kind: 'named', display_name: name, role: 'collaborator', note: 'AI agent' },
        { clientId: getClientId(), displayName: getDisplayName() },
      );
      await refresh();
    } catch (err) {
      reportError('McpPanel.createInvite', err);
      setError('Could not create the link. Only an admin can do this.');
    } finally {
      setCreating(false);
    }
  }

  const origin = window.location.origin;
  const name = agentName.trim() || DEFAULT_AGENT_NAME;
  const mcpUrl = `${origin}/mcp${name === DEFAULT_AGENT_NAME ? '' : `?name=${encodeURIComponent(name)}`}`;
  const cli = `claude mcp add --transport http marginalia ${mcpUrl}`;
  const json = `{
  "mcpServers": {
    "marginalia": {
      "type": "http",
      "url": "${mcpUrl}"
    }
  }
}`;

  return (
    <Box p="3" className="mcp-panel">
      <Text as="p" size="2" color="gray" mb="4">
        Let an AI agent read this document, work through your comments, and suggest edits you can
        accept or reject — the same things a human reviewer can do.
      </Text>

      <Flex align="center" gap="2" mb="2">
        <Badge radius="full" color="gray">
          1
        </Badge>
        <Text size="2" weight="bold">
          Give the agent access
        </Text>
      </Flex>
      <Text as="p" size="2" color="gray" mb="2">
        Agents get in the same way people do — through an invite link. A{' '}
        <strong>collaborator</strong> link lets it comment and suggest edits but decide nothing,
        which is what you want: you stay the one who accepts.
      </Text>

      {!canManageInvites ? (
        <Callout.Root size="1" color="gray" mb="4">
          <Callout.Text>
            Only an admin can create access links. Ask the document owner for a collaborator link,
            then continue with step 2.
          </Callout.Text>
        </Callout.Root>
      ) : (
        <Box mb="4">
          <Flex gap="2" align="end" mb="2">
            <Box flexGrow="1">
              <Text as="label" size="1" color="gray">
                Agent name
                <TextField.Root
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  placeholder={DEFAULT_AGENT_NAME}
                  size="1"
                  mt="1"
                />
              </Text>
            </Box>
            <Button size="1" onClick={() => void mint()} loading={creating}>
              Create link
            </Button>
          </Flex>
          {error && (
            <Text as="p" size="1" color="red" mb="2">
              {error}
            </Text>
          )}
          {agentInvites.length > 0 && (
            <Box>
              <Text as="p" size="1" color="gray" mb="1">
                <CheckIcon /> Give this link to the agent along with your question:
              </Text>
              {agentInvites.map((invite) => (
                <Box key={invite.token} mb="2">
                  <Text as="p" size="1" color="gray">
                    {invite.display_name ?? 'any name'} · {invite.role}
                  </Text>
                  <Copyable text={`${origin}${invite.url}`} multiline size="1" />
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )}

      <Flex align="center" gap="2" mb="2">
        <Badge radius="full" color="gray">
          2
        </Badge>
        <Text size="2" weight="bold">
          Point the agent at this server
        </Text>
      </Flex>
      <Text as="p" size="2" color="gray" mb="2">
        This instance serves the tools itself over HTTP. Nothing to install, nothing to run locally
        — the agent just needs the URL.
      </Text>

      <SegmentedControl.Root
        size="1"
        value={setup}
        onValueChange={(v) => setSetup(v as Setup)}
        mb="2"
      >
        <SegmentedControl.Item value="cli">Command line</SegmentedControl.Item>
        <SegmentedControl.Item value="json">Config file</SegmentedControl.Item>
      </SegmentedControl.Root>

      {setup === 'cli' ? (
        <Box>
          <Copyable text={cli} multiline size="1" />
          <Text as="p" size="1" color="gray" mt="1">
            Run once, in any project. Codex uses{' '}
            <code>codex mcp add marginalia --url {mcpUrl}</code>.
          </Text>
        </Box>
      ) : (
        <Box>
          <Copyable text={json} multiline size="1" />
          <Text as="p" size="1" color="gray" mt="1">
            Goes in <code>.mcp.json</code> in your project, or your client's MCP settings.
          </Text>
        </Box>
      )}

      <Text as="p" size="2" color="gray" mt="4">
        Then ask it something like:{' '}
        <em>
          “Work through the comments on {origin}/d/{uid} and turn them into edit proposals.”
        </em>
      </Text>
    </Box>
  );
}
