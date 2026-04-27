import { inlineAvatarHue, inlineAvatarInitials } from './inlineUtils.js';

interface Props {
  name: string;
  seed?: string;
  size?: 'sm' | 'md';
}

export function InlineAvatar({ name, seed, size = 'md' }: Props) {
  const hue = inlineAvatarHue(seed ?? name);
  const style = { backgroundColor: `hsl(${hue} 55% 45%)` };
  return (
    <div className={`ic-avatar ic-avatar-${size}`} style={style} title={name} aria-hidden>
      {inlineAvatarInitials(name)}
    </div>
  );
}
