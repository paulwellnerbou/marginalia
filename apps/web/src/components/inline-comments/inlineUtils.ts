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

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function inlineFormatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  const month = SHORT_MONTHS[d.getMonth()] ?? '';
  return `${d.getDate()} ${month}, ${time}`;
}

export function inlineFormatTimestampLong(ts: number): string {
  return new Date(ts).toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
