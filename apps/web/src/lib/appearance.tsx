import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Appearance = 'light' | 'dark' | 'auto';

interface AppearanceContextValue {
  appearance: Appearance;
  setAppearance: (a: Appearance) => void;
  /** Effective resolved mode at this instant (auto → what the system says). */
  resolved: 'light' | 'dark';
}

const APPEARANCE_KEY = 'marginalia.appearance';

function readStored(): Appearance {
  const v = localStorage.getItem(APPEARANCE_KEY);
  return v === 'light' || v === 'dark' ? v : 'auto';
}

function resolve(appearance: Appearance): 'light' | 'dark' {
  if (appearance === 'auto') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return appearance;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState<Appearance>(() => readStored());
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolve(readStored()));

  // Persist + mirror onto `<html data-appearance>` so the CSS token layer
  // and the component theme stay in sync.
  useEffect(() => {
    localStorage.setItem(APPEARANCE_KEY, appearance);
    document.documentElement.setAttribute('data-appearance', appearance);
    setResolved(resolve(appearance));
  }, [appearance]);

  // Track system changes only while on 'auto'.
  useEffect(() => {
    if (appearance !== 'auto') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => setResolved(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [appearance]);

  return (
    <AppearanceContext.Provider value={{ appearance, setAppearance, resolved }}>
      {children}
    </AppearanceContext.Provider>
  );
}

export function useAppearance(): AppearanceContextValue {
  const ctx = useContext(AppearanceContext);
  if (!ctx) throw new Error('useAppearance must be used inside <AppearanceProvider>');
  return ctx;
}
