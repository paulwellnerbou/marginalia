import type { Role } from './api.js';

/** The roles a link or an agent key can be given; admin is only ever minted with the document. */
export const GRANTABLE_ROLES: readonly { value: Exclude<Role, 'admin'>; summary: string }[] = [
  { value: 'reader', summary: 'Readers only read.' },
  { value: 'collaborator', summary: 'Collaborators comment and suggest edits.' },
  { value: 'editor', summary: 'Editors also edit directly and accept suggestions.' },
];

export function roleLabel(role: Role): string {
  switch (role) {
    case 'admin':
      return 'Admin';
    case 'editor':
      return 'Editor';
    case 'collaborator':
      return 'Collaborator';
    case 'reader':
      return 'Reader';
  }
}

export function roleSummary(role: Role): string {
  return (
    GRANTABLE_ROLES.find((r) => r.value === role)?.summary ??
    'Admins manage the document and its links.'
  );
}
