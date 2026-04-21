import { EyeOpenIcon } from '@radix-ui/react-icons';
import { Button } from '@radix-ui/themes';

interface Props {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
}

export function ShowDiffButton({ onClick, disabled = false, loading = false }: Props) {
  return (
    <Button size="1" variant="soft" onClick={onClick} disabled={disabled}>
      <EyeOpenIcon />
      {loading ? 'Loading…' : 'Show diff'}
    </Button>
  );
}
