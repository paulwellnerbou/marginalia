import type { DocumentFormat, InviteKind, Role } from '../lib/api.js';

export const APP_THEME = {
  accentColor: 'blue',
  grayColor: 'slate',
  scaling: '100%',
} as const;

export const APP_ACCENT_COLOR = APP_THEME.accentColor;

export function appFormatColor(format: DocumentFormat) {
  return format === 'asciidoc' ? 'plum' : APP_ACCENT_COLOR;
}

export function appRoleColor(role: Role) {
  switch (role) {
    case 'admin':
      return APP_ACCENT_COLOR;
    case 'editor':
      return 'green';
    case 'collaborator':
      return 'amber';
    default:
      return 'gray';
  }
}

export function appInviteKindColor(kind: InviteKind) {
  switch (kind) {
    case 'admin':
      return APP_ACCENT_COLOR;
    case 'named':
      return 'cyan';
    case 'generic':
      return 'gray';
  }
}
