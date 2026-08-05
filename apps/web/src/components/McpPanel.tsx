import { DEFAULT_AGENT_NAME, normalizeAgentName } from '@marginalia/mcp/identity';
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

/**
 * Marks an invite as belonging to an agent rather than a person. Without
 * it this panel would also list the collaborator links minted for human
 * reviewers and offer to "connect" them, which is not what they are.
 */
const AGENT_NOTE = 'AI agent';

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

  const agentInvites = (invites ?? []).filter((i) => i.note === AGENT_NOTE);

  // Normalize exactly as the server will before comparing or minting.
  // Marginalia derives an agent's client id from its name and decides
  // who may edit or delete a comment by client id, so two agents sharing
  // a name are one participant, each able to rewrite the other's work.
  // Comparing raw input would let "Cla<CR><LF>ude" look distinct here
  // and then collapse onto "Claude" server-side. People may share a
  // name; agents must not.
  const normalizedName = normalizeAgentName(agentName);
  const nameTaken = agentInvites.some(
    (i) => normalizeAgentName(i.display_name).toLowerCase() === normalizedName.toLowerCase(),
  );

  async function mint() {
    if (nameTaken) return;
    setCreating(true);
    setError(null);
    try {
      const name = normalizedName;
      // Named, so the agent is @-mentionable before it has ever
      // connected — you can write "@Claude look at this" and let it find
      // the mention on its first visit. The cost is that a named invite
      // seeds its own display name onto a new client's first request, so
      // the connection URL below always carries this same name; see
      // `connectionFor`.
      await createInvite(
        uid,
        { kind: 'named', display_name: name, role: 'collaborator', note: AGENT_NOTE },
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

  /**
   * The connection string for one agent.
   *
   * `?name=` is taken from the invite, never from the name field: a
   * named invite seeds its own display name onto the agent's first
   * request, so if the two disagreed the agent's first comment would be
   * signed with the invite's name and everything after it with the URL's.
   * Deriving one from the other makes that impossible.
   */
  function connectionFor(
    inviteName: string,
    token: string,
  ): { url: string; cli: string; json: string } {
    const params = new URLSearchParams();
    if (inviteName !== DEFAULT_AGENT_NAME) params.set('name', inviteName);
    // Carrying the token on the connection means any reference to this
    // document works, even one the viewer stripped the token from — a
    // copied comment link, say. An explicit token in a pasted URL still
    // wins over it.
    params.set('token', token);
    const url = `${origin}/mcp?${params.toString()}`;
    return {
      url,
      cli: `claude mcp add --transport http marginalia ${url}`,
      json: `{
  "mcpServers": {
    "marginalia": {
      "type": "http",
      "url": "${url}"
    }
  }
}`,
    };
  }

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
            <Button size="1" onClick={() => void mint()} loading={creating} disabled={nameTaken}>
              Create link
            </Button>
          </Flex>
          {nameTaken && (
            <Text as="p" size="1" color="orange" mb="2">
              “{normalizedName}” already has a link on this document. Agents are identified by name,
              so two sharing one would count as the same participant and could edit each other’s
              comments. Pick a different name.
            </Text>
          )}
          {error && (
            <Text as="p" size="1" color="red" mb="2">
              {error}
            </Text>
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
        mb="3"
      >
        <SegmentedControl.Item value="cli">Command line</SegmentedControl.Item>
        <SegmentedControl.Item value="json">Config file</SegmentedControl.Item>
      </SegmentedControl.Root>

      {agentInvites.length === 0 ? (
        <Callout.Root size="1" color="gray">
          <Callout.Text>
            Create an access link above and the exact command for it appears here.
          </Callout.Text>
        </Callout.Root>
      ) : (
        agentInvites.map((invite) => {
          // Normalize on read too: `?name=` has to match what the server
          // derives from it, whatever is stored.
          const inviteName = normalizeAgentName(invite.display_name);
          const connection = connectionFor(inviteName, invite.token);
          return (
            <Box key={invite.token} mb="4">
              <Text as="p" size="2" weight="bold" mb="1">
                {inviteName}
              </Text>
              <Text as="p" size="1" color="gray" mb="1">
                Connect it:
              </Text>
              <Copyable
                text={setup === 'cli' ? connection.cli : connection.json}
                multiline
                size="1"
              />
              <Text as="p" size="1" color="gray" mt="2" mb="1">
                Then give it this link to the document:
              </Text>
              <Copyable text={`${origin}${invite.url}`} multiline size="1" />
              <Text as="p" size="1" color="gray" mt="1">
                The connection above already carries this agent’s access, so a link copied from a
                comment works too — even without the token in it.
              </Text>
            </Box>
          );
        })
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
