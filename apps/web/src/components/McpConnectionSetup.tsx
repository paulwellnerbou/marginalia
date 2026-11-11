import { Box, Flex, SegmentedControl, Select, Text } from '@radix-ui/themes';
import {
  CLAUDE_SCOPES,
  type ClaudeScope,
  connectionSetups,
  MCP_CLIENTS,
  type McpClient,
  SETUP_LABELS,
  type Setup,
} from '../lib/mcp-connection.js';
import { Copyable } from './Copyable.js';

/**
 * The client picker and the copyable setup for one MCP connection URL.
 * Stateless: the caller owns the choices, so several connections on one
 * screen can share a setup tab and a Claude scope.
 */
export function McpConnectionSetup({
  url,
  idPrefix,
  client,
  onClientChange,
  setup,
  onSetupChange,
  claudeScope,
  onClaudeScopeChange,
  serverName,
}: {
  url: string;
  /** Unique per connection on the page, for the labels' `htmlFor`. */
  idPrefix: string;
  client: McpClient;
  onClientChange: (client: McpClient) => void;
  setup: Setup;
  onSetupChange: (setup: Setup) => void;
  claudeScope: ClaudeScope;
  onClaudeScopeChange: (scope: ClaudeScope) => void;
  /** What the client registers the server as; one per keyring. */
  serverName?: string;
}) {
  const setups = connectionSetups(client, url, claudeScope, serverName);
  const snippet = setups.find((s) => s.setup === setup) ?? setups[0];
  const showScope = client === 'claude' && snippet.setup === 'cli';

  return (
    <Box>
      <Flex align="center" gap="2" mb="2">
        <Text as="label" size="1" color="gray" htmlFor={`${idPrefix}-client`}>
          Connect it from
        </Text>
        <Select.Root size="1" value={client} onValueChange={(v) => onClientChange(v as McpClient)}>
          <Select.Trigger id={`${idPrefix}-client`} />
          <Select.Content position="popper">
            {MCP_CLIENTS.map((c) => (
              <Select.Item key={c.value} value={c.value}>
                {c.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </Flex>
      {setups.length > 1 && (
        <SegmentedControl.Root
          size="1"
          value={snippet.setup}
          onValueChange={(v) => onSetupChange(v as Setup)}
          mb="2"
        >
          {setups.map((s) => (
            <SegmentedControl.Item key={s.setup} value={s.setup}>
              {SETUP_LABELS[s.setup]}
            </SegmentedControl.Item>
          ))}
        </SegmentedControl.Root>
      )}
      {showScope && (
        <Flex align="center" gap="2" mb="2" wrap="wrap">
          <Text as="label" size="1" color="gray" htmlFor={`${idPrefix}-scope`}>
            Scope
          </Text>
          <Select.Root
            size="1"
            value={claudeScope}
            onValueChange={(v) => onClaudeScopeChange(v as ClaudeScope)}
          >
            <Select.Trigger id={`${idPrefix}-scope`} />
            <Select.Content position="popper">
              {CLAUDE_SCOPES.map((s) => (
                <Select.Item key={s.value} value={s.value}>
                  {s.label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          <Text size="1" color="gray">
            {CLAUDE_SCOPES.find((s) => s.value === claudeScope)?.description}
          </Text>
        </Flex>
      )}
      <Text as="p" size="1" color="gray" mb="1">
        {snippet.instruction}
      </Text>
      <Copyable text={snippet.text} multiline size="1" />
      {snippet.note && (
        <Text as="p" size="1" color="orange" mt="1">
          {snippet.note}
        </Text>
      )}
    </Box>
  );
}
