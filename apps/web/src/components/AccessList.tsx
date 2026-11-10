import { Badge, Box, Flex, Select, Text } from '@radix-ui/themes';
import { Children, type FormEvent, type ReactNode } from 'react';
import type { Role } from '../lib/api.js';
import { GRANTABLE_ROLES, roleLabel } from '../lib/roles.js';
import { appRoleColor } from '../styles/theme.js';

/**
 * The shared layout for things that grant access — the share dialog's links
 * and the keyring's agent keys. Controls sit in a tinted form box; what
 * exists sits in a bordered list under its own count, so an entry never
 * reads as part of the surrounding chrome.
 */

export function AccessCreateForm({
  title,
  onSubmit,
  hint,
  children,
}: {
  title: string;
  onSubmit: () => void;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <form
      className="access-create"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <Text as="div" size="2" weight="medium" mb="2">
        {title}
      </Text>
      <Flex gap="2" align="end" wrap="wrap">
        {children}
      </Flex>
      {hint && (
        <Text as="p" size="1" color="gray" mt="2">
          {hint}
        </Text>
      )}
    </form>
  );
}

export function AccessField({
  label,
  htmlFor,
  grow = false,
  children,
}: {
  label: ReactNode;
  htmlFor: string;
  grow?: boolean;
  children: ReactNode;
}) {
  return (
    <Box style={grow ? { flex: '1 1 10rem', minWidth: 0 } : undefined}>
      <Text as="label" size="1" color="gray" htmlFor={htmlFor} className="access-field-label">
        {label}
      </Text>
      {children}
    </Box>
  );
}

export function AccessList({
  title,
  aside,
  loading,
  empty,
  children,
}: {
  title: string;
  aside?: ReactNode;
  loading: boolean;
  empty: string;
  children: ReactNode;
}) {
  const count = Children.toArray(children).length;
  return (
    <Box>
      <Flex align="center" justify="between" gap="3" wrap="wrap" mb="2">
        <Text size="2" weight="medium">
          {title}
          {!loading && count > 0 && (
            <Text color="gray" weight="regular">
              {' '}
              · {count}
            </Text>
          )}
        </Text>
        {aside}
      </Flex>
      <div className="access-list">
        {loading ? (
          <Text as="p" size="1" color="gray" className="access-list__empty">
            Loading…
          </Text>
        ) : count === 0 ? (
          <Text as="p" size="1" color="gray" className="access-list__empty">
            {empty}
          </Text>
        ) : (
          children
        )}
      </div>
    </Box>
  );
}

export function AccessRow({
  name,
  role,
  meta,
  action,
  children,
}: {
  name: ReactNode;
  role: ReactNode;
  meta: ReactNode;
  action: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Flex direction="column" gap="2" className="access-list__row">
      <Box>
        <Flex align="start" justify="between" gap="2">
          <Flex align="center" gap="2" wrap="wrap" minWidth="0">
            <Text size="2" weight="medium">
              {name}
            </Text>
            {role}
          </Flex>
          <Box flexShrink="0">{action}</Box>
        </Flex>
        <Text as="p" size="1" color="gray" mt="1">
          {meta}
        </Text>
      </Box>
      {children}
    </Flex>
  );
}

export function RoleBadge({ role }: { role: Role }) {
  return (
    <Badge size="1" color={appRoleColor(role)} variant="soft" className="role-badge">
      {roleLabel(role)}
    </Badge>
  );
}

/**
 * `field` is the form control; `badge` edits a row's role in place and
 * looks like the `RoleBadge` it stands in for.
 */
export function RoleSelect({
  value,
  onChange,
  look,
  id,
  ariaLabel,
  disabled,
}: {
  value: Role;
  onChange: (role: Exclude<Role, 'admin'>) => void;
  look: 'field' | 'badge';
  id?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <Select.Root
      value={value}
      onValueChange={(v) => onChange(v as Exclude<Role, 'admin'>)}
      size={look === 'field' ? '2' : '1'}
      disabled={disabled}
    >
      <Select.Trigger
        id={id}
        variant={look === 'field' ? 'surface' : 'soft'}
        color={look === 'badge' ? appRoleColor(value) : undefined}
        className={look === 'badge' ? 'role-badge' : undefined}
        aria-label={ariaLabel}
      />
      <Select.Content position="popper">
        {GRANTABLE_ROLES.map((r) => (
          <Select.Item key={r.value} value={r.value}>
            {roleLabel(r.value)}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}
