import { EyeNoneIcon, EyeOpenIcon } from '@radix-ui/react-icons';
import { TextField } from '@radix-ui/themes';
import { type ComponentPropsWithoutRef, forwardRef, type MouseEvent, useState } from 'react';

type PasswordFieldProps = Omit<ComponentPropsWithoutRef<typeof TextField.Root>, 'type'>;

export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(
  function PasswordField({ children, ...props }, ref) {
    const [revealed, setRevealed] = useState(false);

    function keepFocus(event: MouseEvent<HTMLButtonElement>) {
      event.preventDefault();
    }

    return (
      <TextField.Root {...props} ref={ref} type={revealed ? 'text' : 'password'}>
        {children}
        <TextField.Slot side="right">
          <button
            type="button"
            className="password-field-toggle"
            aria-label={revealed ? 'Hide password' : 'Show password'}
            aria-pressed={revealed}
            onMouseDown={keepFocus}
            onClick={() => setRevealed((value) => !value)}
          >
            {revealed ? <EyeNoneIcon /> : <EyeOpenIcon />}
          </button>
        </TextField.Slot>
      </TextField.Root>
    );
  },
);
