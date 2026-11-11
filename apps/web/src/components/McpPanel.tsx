import { DEFAULT_AGENT_NAME, normalizeAgentName } from '@marginalia/mcp/identity';
import { Badge, Box, Button, Callout, Flex, Text, TextField } from '@radix-ui/themes';
import { useCallback, useEffect, useState } from 'react';
import {
  type AgentKeyDocumentWire,
  type AgentKeyWire,
  createInvite,
  type Invite,
  listAgentKeys,
  listInvites,
  setAgentDocumentRole,
} from '../lib/api.js';
import { apiErrorMessage } from '../lib/apiErrorMessage.js';
import { getClientId, getDisplayName } from '../lib/identity.js';
import { keyringForDoc, onKeyringChange } from '../lib/keyring.js';
import { reportError } from '../lib/log.js';
import {
  type ClaudeScope,
  guessClient,
  type McpClient,
  type Setup,
} from '../lib/mcp-connection.js';
import { type GrantableRole, roleLabel } from '../lib/roles.js';
import { AccessList, AccessRow, RoleBadge, RoleSelect } from './AccessList.js';
import { Copyable } from './Copyable.js';
import { McpConnectionSetup } from './McpConnectionSetup.js';

interface Props {
  uid: string;
  /** Only an admin can mint the agent's access link. */
  canManageInvites: boolean;
}

/**
 * Marks an invite as belonging to an agent rather than a person. Without
 * it this panel would also list the collaborator links minted for human
 * reviewers and offer to "connect" them, which is not what they are.
 */
const AGENT_NOTE = 'AI agent';

/** The server's note on invites it mints for a keyring's agent keys. */
const KEYRING_AGENT_NOTE = 'AI agent via keyring';

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
  // The ring this document belongs to: its agent keys are the ones that reach it.
  const [ringToken, setRingToken] = useState(() => keyringForDoc(uid)?.token ?? null);
  const [keys, setKeys] = useState<AgentKeyWire[] | null>(null);
  const [savingKeys, setSavingKeys] = useState<ReadonlySet<string>>(new Set());
  const [keyError, setKeyError] = useState<string | null>(null);
  const [agentName, setAgentName] = useState(DEFAULT_AGENT_NAME);
  // Per invite token; unset means the guess from the agent's name.
  const [clients, setClients] = useState<Record<string, McpClient>>({});
  // Shared by every agent; a client without this kind of setup shows its first.
  const [setup, setSetup] = useState<Setup>('cli');
  const [claudeScope, setClaudeScope] = useState<ClaudeScope>('local');
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

  // A key reaches this document the first time its agent opens it, so
  // its name is spoken for here before it has an invite.
  useEffect(() => {
    setRingToken(keyringForDoc(uid)?.token ?? null);
    return onKeyringChange(() => setRingToken(keyringForDoc(uid)?.token ?? null));
  }, [uid]);

  useEffect(() => {
    setKeys(null);
    if (!ringToken || !canManageInvites) return;
    // An answer for a keyring this browser has since left must not land.
    let current = true;
    listAgentKeys(ringToken, { doc: uid })
      .then((res) => {
        if (current) setKeys(res.agents);
      })
      .catch((err) => reportError('McpPanel.listAgentKeys', err));
    return () => {
      current = false;
    };
  }, [ringToken, uid, canManageInvites]);
  const keyNames = (keys ?? []).map((k) => k.display_name);

  async function changeKeyRole(id: string, next: GrantableRole) {
    if (!ringToken) return;
    setKeyError(null);
    const key = keys?.find((k) => k.id === id);
    const previous = key?.document;
    if (!key || !previous) return;
    const setDocument = (document: AgentKeyDocumentWire) =>
      setKeys((current) => current?.map((k) => (k.id === id ? { ...k, document } : k)) ?? current);
    // Mirrors the server: a document set to the key's own role follows the key again.
    setDocument({ ...previous, role: next, invited: true, follows_key: next === key.role });
    setSavingKeys((current) => new Set(current).add(id));
    try {
      await setAgentDocumentRole(ringToken, id, uid, next);
      // The agent's invite here is an ordinary link, listed with the others.
      await refresh();
    } catch (err) {
      reportError('McpPanel.setAgentDocumentRole', err);
      setDocument(previous);
      setKeyError(apiErrorMessage(err, 'Could not change the agent’s role'));
    } finally {
      setSavingKeys((current) => {
        const rest = new Set(current);
        rest.delete(id);
        return rest;
      });
    }
  }

  const agentInvites = (invites ?? []).filter((i) => i.note === AGENT_NOTE);

  // Normalize exactly as the server will before comparing or minting.
  // Marginalia derives an agent's client id from its name and decides
  // who may edit or delete a comment by client id, so two agents sharing
  // a name are one participant, each able to rewrite the other's work.
  // Comparing raw input would let "Cla<CR><LF>ude" look distinct here
  // and then collapse onto "Claude" server-side. People may share a
  // name; agents must not.
  const normalizedName = normalizeAgentName(agentName);
  const sameName = (name: string | null) =>
    normalizeAgentName(name).toLowerCase() === normalizedName.toLowerCase();
  const nameTaken = agentInvites.some((i) => sameName(i.display_name));
  // Different client ids, so no shared authorship, but one name in
  // comments and @-mentions for two agents nobody can tell apart.
  const keyNameTaken =
    !nameTaken &&
    (keyNames.some(sameName) ||
      (invites ?? []).some((i) => i.note === KEYRING_AGENT_NOTE && sameName(i.display_name)));

  async function mint() {
    if (nameTaken || keyNameTaken) return;
    setCreating(true);
    setError(null);
    try {
      const name = normalizedName;
      // Named, so the agent is @-mentionable before it has ever
      // connected — you can write "@Claude look at this" and let it find
      // the mention on its first visit. The cost is that a named invite
      // seeds its own display name onto a new client's first request, so
      // the connection URL below always carries this same name; see
      // `connectionUrl`.
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
   * The connection URL for one agent.
   *
   * `?name=` is taken from the invite, never from the name field: a
   * named invite seeds its own display name onto the agent's first
   * request, so if the two disagreed the agent's first comment would be
   * signed with the invite's name and everything after it with the URL's.
   * Deriving one from the other makes that impossible.
   */
  function connectionUrl(inviteName: string, token: string): string {
    const params = new URLSearchParams();
    if (inviteName !== DEFAULT_AGENT_NAME) params.set('name', inviteName);
    // Carrying the token on the connection means any reference to this
    // document works, even one the viewer stripped the token from — a
    // copied comment link, say. An explicit token in a pasted URL still
    // wins over it.
    params.set('token', token);
    return `${origin}/mcp?${params.toString()}`;
  }

  return (
    <Box p="3" className="mcp-panel">
      <Text as="p" size="2" color="gray" mb="4">
        Let an AI agent read this document, work through your comments, and suggest edits you can
        accept or reject — the same things a human reviewer can do.
      </Text>

      {keys && keys.length > 0 && (
        <Box mb="5">
          <AccessList title="Your keyring’s agents" loading={false} empty="">
            {keys.map((key) => (
              <AccessRow
                key={key.id}
                name={key.display_name}
                role={
                  key.document?.link_stale ? (
                    <RoleBadge role={key.document.role} />
                  ) : key.document ? (
                    <RoleSelect
                      look="badge"
                      value={key.document.role}
                      onChange={(next) => void changeKeyRole(key.id, next)}
                      disabled={savingKeys.has(key.id)}
                      ariaLabel={`Role for ${key.display_name} on this document: ${roleLabel(key.document.role)}`}
                    />
                  ) : null
                }
                meta={keyMeta(key)}
                action={null}
              />
            ))}
          </AccessList>
          {keyError && (
            <Text as="p" size="1" color="red" mt="2">
              {keyError}
            </Text>
          )}
          <Text as="p" size="1" color="gray" mt="2">
            These connect through your keyring, so they need no link of their own. The role here is
            for{' '}
            {keys.some((k) => k.document?.folder)
              ? 'this document and the others that share its links'
              : 'this document only'}
            ; a key’s role everywhere else is set under “Your devices” on the start page.
          </Text>
        </Box>
      )}

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
            <Button
              size="1"
              onClick={() => void mint()}
              loading={creating}
              disabled={nameTaken || keyNameTaken}
            >
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
          {keyNameTaken && (
            <Text as="p" size="1" color="orange" mb="2">
              “{normalizedName}” is an agent key in your keyring, which works on this document under
              that name. Two agents sharing it could not be told apart in comments. Pick a different
              name.
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

      {agentInvites.length === 0 ? (
        <Callout.Root size="1" color="gray">
          <Callout.Text>
            Create an access link above and the exact setup for it appears here.
          </Callout.Text>
        </Callout.Root>
      ) : (
        agentInvites.map((invite) => {
          // Normalize on read too: `?name=` has to match what the server
          // derives from it, whatever is stored.
          const inviteName = normalizeAgentName(invite.display_name);
          const client = clients[invite.token] ?? guessClient(inviteName);
          return (
            <Box key={invite.token} mb="4">
              <Text as="p" size="2" weight="bold" mb="1">
                {inviteName}
              </Text>
              <McpConnectionSetup
                url={connectionUrl(inviteName, invite.token)}
                idPrefix={`mcp-${invite.token}`}
                client={client}
                onClientChange={(v) => setClients((prev) => ({ ...prev, [invite.token]: v }))}
                setup={setup}
                onSetupChange={setSetup}
                claudeScope={claudeScope}
                onClaudeScopeChange={setClaudeScope}
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

function keyMeta(key: AgentKeyWire): string {
  if (!key.document) return 'Your keyring holds no admin link here, so this key cannot open it.';
  if (key.document.link_stale) {
    return 'This document’s admin link was replaced on another device. Sync there to change the role.';
  }
  if (key.document.follows_key) return 'Follows its key';
  return `Set here · key role ${roleLabel(key.role)}`;
}
