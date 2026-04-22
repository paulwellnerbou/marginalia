import { useEffect, useState } from 'react';

const PASSWORD_PREFIX = 'marginalia.password.';
const REMEMBER_LOGIN_KEY = 'marginalia.rememberLogin';
const PASSWORD_STORAGE_EVENT = 'marginalia:password-storage-change';

function passwordKey(docUid: string): string {
  return PASSWORD_PREFIX + docUid;
}

export function loadSavedPassword(docUid: string): string | null {
  try {
    return localStorage.getItem(passwordKey(docUid));
  } catch {
    return null;
  }
}

export function saveSavedPassword(docUid: string, password: string): void {
  try {
    localStorage.setItem(passwordKey(docUid), password);
    window.dispatchEvent(new CustomEvent(PASSWORD_STORAGE_EVENT, { detail: { docUid } }));
  } catch {
    /* quota exceeded — best-effort */
  }
}

export function clearSavedPassword(docUid: string): void {
  try {
    localStorage.removeItem(passwordKey(docUid));
    window.dispatchEvent(new CustomEvent(PASSWORD_STORAGE_EVENT, { detail: { docUid } }));
  } catch {
    /* ignore */
  }
}

export function loadRememberLoginPreference(): boolean {
  try {
    return localStorage.getItem(REMEMBER_LOGIN_KEY) !== '0';
  } catch {
    return true;
  }
}

export function saveRememberLoginPreference(remember: boolean): void {
  try {
    localStorage.setItem(REMEMBER_LOGIN_KEY, remember ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export function useSavedPassword(docUid: string | undefined): string | null {
  const [password, setPassword] = useState<string | null>(() =>
    docUid ? loadSavedPassword(docUid) : null,
  );

  useEffect(() => {
    if (!docUid) {
      setPassword(null);
      return;
    }
    const sync = () => setPassword(loadSavedPassword(docUid));
    sync();
    const inApp = (event: Event) => {
      const detail = (event as CustomEvent<{ docUid?: string }>).detail;
      if (detail?.docUid === docUid) sync();
    };
    const crossTab = (event: StorageEvent) => {
      if (event.key === passwordKey(docUid)) sync();
    };
    window.addEventListener(PASSWORD_STORAGE_EVENT, inApp);
    window.addEventListener('storage', crossTab);
    return () => {
      window.removeEventListener(PASSWORD_STORAGE_EVENT, inApp);
      window.removeEventListener('storage', crossTab);
    };
  }, [docUid]);

  return password;
}

function credentialIdForDoc(docUid: string): string {
  return `document:${docUid}`;
}

type WindowWithPasswordCredential = Window & {
  PasswordCredential?: new (data: { id: string; password: string; name?: string }) => Credential;
};

export function supportsBrowserPasswordManager(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ctor = (window as WindowWithPasswordCredential).PasswordCredential;
  return typeof ctor === 'function' && typeof navigator.credentials?.store === 'function';
}

export async function storePasswordInBrowserPasswordManager(
  docUid: string,
  password: string,
): Promise<boolean> {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ctor = (window as WindowWithPasswordCredential).PasswordCredential;
  if (!ctor || typeof navigator.credentials?.store !== 'function') return false;
  const credential = new ctor({
    id: credentialIdForDoc(docUid),
    name: `Marginalia document ${docUid}`,
    password,
  });
  await navigator.credentials.store(credential);
  return true;
}

export function browserPasswordManagerUsername(docUid: string): string {
  return credentialIdForDoc(docUid);
}
