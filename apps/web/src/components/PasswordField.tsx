import { forwardRef, useState, type ComponentPropsWithoutRef, type MouseEvent } from 'react';
import { TextInput } from '@mantine/core';
import { EyeNoneIcon, EyeOpenIcon } from '../icons.js';

type PasswordFieldProps = Omit<ComponentPropsWithoutRef<typeof TextInput>, 'type' | 'rightSection'>;

export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(
  function PasswordField(props, ref) {
    const [revealed, setRevealed] = useState(false);

    function keepFocus(event: MouseEvent<HTMLButtonElement>) {
      event.preventDefault();
    }

    return (
      <TextInput
        {...props}
        ref={ref}
        type={revealed ? 'text' : 'password'}
        rightSection={
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
        }
      />
    );
  },
);
