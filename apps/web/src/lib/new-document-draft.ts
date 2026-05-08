import { type DocumentFormat, isDocumentFormat } from './api.js';

const PENDING_NEW_DOCUMENT_DRAFT_KEY = 'marginalia.pendingNewDocumentDraft';

export interface PendingNewDocumentDraft {
  source: string;
  format: DocumentFormat;
  docName?: string;
}

export function savePendingNewDocumentDraft(draft: PendingNewDocumentDraft): void {
  if (typeof window === 'undefined') return;

  try {
    const payload: Record<string, unknown> = {
      source: draft.source,
      format: draft.format,
    };
    if (draft.docName) payload.docName = draft.docName;
    window.sessionStorage.setItem(PENDING_NEW_DOCUMENT_DRAFT_KEY, JSON.stringify(payload));
  } catch {
    // Best-effort handoff only. If storage is unavailable, the caller
    // should surface its own generic failure state.
  }
}

export function consumePendingNewDocumentDraft(): PendingNewDocumentDraft | null {
  if (typeof window === 'undefined') return null;

  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(PENDING_NEW_DOCUMENT_DRAFT_KEY);
    window.sessionStorage.removeItem(PENDING_NEW_DOCUMENT_DRAFT_KEY);
  } catch {
    return null;
  }

  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.source !== 'string' || !isDocumentFormat(parsed.format)) return null;
    const docName = typeof parsed.docName === 'string' ? parsed.docName : undefined;
    return {
      source: parsed.source,
      format: parsed.format,
      ...(docName ? { docName } : {}),
    };
  } catch {
    return null;
  }
}
