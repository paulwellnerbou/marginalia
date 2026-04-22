import { EyeOpenIcon } from '../icons.js';
import { Button } from '@mantine/core';

interface Props {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
}

export function ShowDiffButton({ onClick, disabled = false, loading = false }: Props) {
  return (
    <Button size="xs" variant="light" onClick={onClick} disabled={disabled}>
      <EyeOpenIcon />
      {loading ? 'Loading…' : 'Show diff'}
    </Button>
  );
}
