import { DEFAULT_AGENT_NAME, normalizeAgentName } from '@marginalia/mcp/identity';
import { TrashIcon } from '@radix-ui/react-icons';
import {
  Badge,
  Box,
  Button,
  Callout,
  Dialog,
  Flex,
  Select,
  Text,
  TextField,
} from '@radix-ui/themes';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  type AgentKeyWire,
  createAgentKey,
  deleteAgentKey,
  listAgentKeys,
  type Role,
} from '../lib/api.js';
import { apiErrorMessage } from '../lib/apiErrorMessage.js';
import { formatTimestamp } from '../lib/format-time.js';
import { loadKeyringToken, onKeyringChange } from '../lib/keyring.js';
import { reportError } from '../lib/log.js';
import {
  type ClaudeScope,
  guessClient,
  type McpClient,
  type Setup,
} from '../lib/mcp-connection.js';
import { ArmedButton } from './ArmedButton.js';
import { McpConnectionSetup } from './McpConnectionSetup.js';

const ROLES: { value: Role; label: string; description: string }[] = [
  { value: 'collaborator', label: 'Collaborator', description: 'comments and suggests edits' },
  { value: 'editor', label: 'Editor', description: 'also edits and accepts suggestions' },
  { value: 'reader', label: 'Reader', description: 'only reads' },
];

/**
 * One MCP connection for the whole keyring.
 *
 * The keyring token never leaves this browser; the agent gets a key of
 * its own, which the server swaps for an ordinary invite per document it
 * opens. The key is in the create response and nowhere else, so the
 * dialog that shows it is the only chance to copy it.
 */
export function AgentKeysPanel() {
  const [token, setToken] = useState(() => loadKeyringToken());
  const [agents, setAgents] = useState<AgentKeyWire[] | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('collaborator');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ key: string; agent: AgentKeyWire } | null>(null);

  useEffect(() => onKeyringChange(setToken), []);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      setAgents((await listAgentKeys(token)).agents);
    } catch (err) {
      reportError('AgentKeysPanel.list', err);
      setAgents([]);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Judged as the server will judge it, so the warning and the 409 agree.
  const normalizedName = normalizeAgentName(name);
  const taken = (candidate: string) =>
    (agents ?? []).some((a) => a.display_name.toLowerCase() === candidate.toLowerCase());
  const nameTaken = taken(normalizedName);
  // An empty field stands for the default name. Warning about it before
  // anything is typed would greet every visit, so that case is explained
  // on submit instead of disabling the button without a word.
  const typedNameTaken = nameTaken && name.trim() !== '';
  // An empty field means the default name, so say so only while it is free.
  const placeholder = taken(DEFAULT_AGENT_NAME) ? 'Name' : DEFAULT_AGENT_NAME;

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!token || typedNameTaken) return;
    if (nameTaken) {
      setError(`“${normalizedName}” already has a key. Give this agent a name of its own.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await createAgentKey(token, { display_name: normalizedName, role });
      setCreated(res);
      setName('');
      await refresh();
    } catch (err) {
      reportError('AgentKeysPanel.create', err);
      setError(apiErrorMessage(err, 'Could not create the agent key'));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!token) return;
    setError(null);
    try {
      await deleteAgentKey(token, id);
      await refresh();
    } catch (err) {
      reportError('AgentKeysPanel.revoke', err);
      setError(apiErrorMessage(err, 'Could not revoke the agent key'));
    }
  }

  if (!token) return null;

  return (
    <Box>
      <Text size="2" weight="medium" as="p" mb="1">
        AI agents
      </Text>
      <Text size="1" color="gray" as="p" mb="3">
        Connect an agent to every document here that you administer, with one URL. It signs with its
        own name, gets at most the role you pick, and revoking its key cuts it off everywhere at
        once.
      </Text>

      {agents && agents.length > 0 && (
        <Flex direction="column" gap="2" mb="3">
          {agents.map((agent) => (
            <Flex key={agent.id} gap="3" align="center" justify="between" wrap="wrap">
              <Box style={{ minWidth: 0 }}>
                <Flex gap="2" align="center">
                  <Text size="2" weight="medium">
                    {agent.display_name}
                  </Text>
                  <Badge variant="soft" color="gray">
                    {agent.role}
                  </Badge>
                </Flex>
                <Text size="1" color="gray">
                  {agent.last_used_at === null
                    ? 'Not used yet'
                    : `Last used ${formatTimestamp(agent.last_used_at)} · ${agent.documents} document${agent.documents === 1 ? '' : 's'}`}
                </Text>
              </Box>
              <ArmedButton
                label="Revoke"
                confirmLabel="Revoke everywhere"
                color="red"
                icon={<TrashIcon />}
                onConfirm={() => revoke(agent.id)}
              />
            </Flex>
          ))}
        </Flex>
      )}

      <form onSubmit={create}>
        <Flex gap="2" align="end" wrap="wrap">
          <Box style={{ flex: '1 1 10rem', minWidth: 0 }}>
            <Text as="label" size="1" color="gray">
              Agent name
              <TextField.Root
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                placeholder={placeholder}
                size="1"
                mt="1"
                disabled={busy}
              />
            </Text>
          </Box>
          <Box>
            <Text as="label" size="1" color="gray" htmlFor="agent-key-role">
              Role
            </Text>
            <Box mt="1">
              <Select.Root size="1" value={role} onValueChange={(v) => setRole(v as Role)}>
                <Select.Trigger id="agent-key-role" />
                <Select.Content position="popper">
                  {ROLES.map((r) => (
                    <Select.Item key={r.value} value={r.value}>
                      {r.label}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Box>
          </Box>
          <Button size="1" type="submit" variant="soft" loading={busy} disabled={typedNameTaken}>
            Create agent key
          </Button>
        </Flex>
      </form>
      <Text as="p" size="1" color="gray" mt="1">
        As {ROLES.find((r) => r.value === role)?.label.toLowerCase()}, it{' '}
        {ROLES.find((r) => r.value === role)?.description}.
      </Text>
      {typedNameTaken && (
        <Text as="p" size="1" color="orange" mt="2">
          “{normalizedName}” already has a key. Agents are told apart by name in comments, so pick
          another.
        </Text>
      )}
      {error && (
        <Callout.Root color="red" size="1" mt="2">
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}

      <AgentKeyDialog
        created={created}
        onOpenChange={(open) => {
          if (!open) setCreated(null);
        }}
      />
    </Box>
  );
}

function AgentKeyDialog({
  created,
  onOpenChange,
}: {
  created: { key: string; agent: AgentKeyWire } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [client, setClient] = useState<McpClient | null>(null);
  const [setup, setSetup] = useState<Setup>('cli');
  const [claudeScope, setClaudeScope] = useState<ClaudeScope>('user');

  useEffect(() => {
    if (created) setClient(null);
  }, [created]);

  const name = created?.agent.display_name ?? DEFAULT_AGENT_NAME;
  const url = created ? `${window.location.origin}/mcp?key=${encodeURIComponent(created.key)}` : '';

  return (
    <Dialog.Root open={created !== null} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="34rem" className="dialog-content--fixed-footer">
        <div className="dialog-scroll-body">
          <Dialog.Title>Connect {name}</Dialog.Title>
          <Dialog.Description size="2" color="gray" mb="3">
            This URL is shown once — set it up now. It works for every document in your keyring that
            you administer, and for the documents {name} creates, which land in your list on all
            your devices.
          </Dialog.Description>

          {created && (
            <McpConnectionSetup
              url={url}
              idPrefix="agent-key"
              client={client ?? guessClient(name)}
              onClientChange={setClient}
              setup={setup}
              onSetupChange={setSetup}
              claudeScope={claudeScope}
              onClaudeScopeChange={setClaudeScope}
            />
          )}

          <Text as="p" size="2" color="gray" mt="3">
            Then ask it something like:{' '}
            <em>“List my Marginalia documents and work through the comments on the newest one.”</em>
          </Text>

          <Callout.Root color="amber" size="1" mt="3">
            <Callout.Text>
              Anyone with this URL works on those documents as {name}. If it ends up somewhere it
              shouldn’t, revoke the key here: that removes every link it was given.
            </Callout.Text>
          </Callout.Root>
        </div>

        <Flex className="dialog-footer" justify="end" mt="4">
          <Dialog.Close>
            <Button variant="soft">Done</Button>
          </Dialog.Close>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
