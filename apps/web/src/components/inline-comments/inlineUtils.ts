export function inlineAvatarInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    return parts
      .map((part) => Array.from(part)[0] ?? '')
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }
  return Array.from(trimmed).slice(0, 2).join('').toUpperCase();
}

export function inlineAvatarHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}
