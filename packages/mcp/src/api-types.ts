/**
 * Wire shapes returned by `apps/server`. Only the fields this MCP
 * server reads are declared — the API is additive, so unknown fields
 * are ignored rather than rejected.
 */

export type DocumentFormat = 'markdown' | 'asciidoc';
export type Role = 'admin' | 'editor' | 'collaborator' | 'reader';
/** `orphaned` and `conflict` mean the anchor no longer resolves against the current source. */
export type LinkStatus = 'linked' | 'low-confidence' | 'conflict' | 'orphaned';
export type ThreadState = 'open' | 'resolved';
export type ResolutionKind = 'resolve' | 'accept' | 'reject';

export interface BlockInfoWire {
  id: string;
  kind: string;
  text: string;
  headingPath: string[];
  sectionIndex: number;
  sectionIndexPath: number[];
}

export interface AnchorWire {
  level: number;
  text: string;
  /** Slug used as the element id, and as the `#fragment` in a viewer link. */
  id: string;
}

export interface TocNodeWire extends AnchorWire {
  children: TocNodeWire[];
}

export interface AttachedAssetWire {
  ref_name: string;
  asset_id: string;
  kind: string;
  mime: string;
  size: number;
  created_at: number;
  created_by: string;
}

export interface DocumentWire {
  uid: string;
  name: string | null;
  source: string;
  rendered: {
    html: string;
    /** Every heading, flat, in document order. */
    anchors: AnchorWire[];
    toc: TocNodeWire[];
    blocks: BlockInfoWire[];
    frontmatter: Record<string, unknown>;
    warnings: Array<{ kind: string; message: string; line?: number }>;
  };
  attached_assets: AttachedAssetWire[];
  format: DocumentFormat;
  default_theme: string;
  password_protected: boolean;
  /**
   * True → the document URL alone grants nothing; only invite-link
   * holders can read it. Optional so a response from an older instance
   * still parses.
   */
  invite_only?: boolean;
  role: Role;
  display_name: string | null;
  created_at: number;
  updated_at: number;
}

export interface ThreadCommentWire {
  id: string;
  hidden?: boolean;
  body: string;
  author: { client_id: string; display_name: string };
  capabilities: { edit: boolean; delete: boolean; hide?: boolean; react: boolean };
  reactions: Array<{ emoji: string; count: number; reacted: boolean; authors: string[] }>;
  created_at: number;
  updated_at: number;
}

export interface ThreadWire {
  id: string;
  state: ThreadState;
  resolution: { kind: ResolutionKind; at: number; by_name: string | null } | null;
  link_status: LinkStatus;
  anchor: {
    block_id: string | null;
    end_block_id: string | null;
    quote: string | null;
    prefix: string;
    suffix: string;
    start_offset: number | null;
    end_offset: number | null;
    heading_path: string[] | null;
    section_index: number | null;
    section_index_path: number[] | null;
  };
  capabilities: {
    reply: boolean;
    resolve: boolean;
    accept: boolean;
    reject: boolean;
    /** Whether the viewer may replace this proposal's proposed text in place. */
    update: boolean;
    repair: boolean;
    reopen: boolean;
  };
  /** Edit proposals written to answer this thread, oldest first. */
  answered_by_thread_ids: string[];
  proposal: {
    source_snapshot: string | null;
    proposed_text: string | null;
    whole_document: boolean;
    /** Root thread this proposal answers, or null if it stands alone. */
    answers_thread_id: string | null;
  } | null;
  comments: ThreadCommentWire[];
}

export interface ListThreadsWire {
  threads: ThreadWire[];
  /**
   * Whole-document totals, whatever the request asked for — the only way
   * to tell that threads were filtered out rather than absent. Optional:
   * an older server omits it.
   */
  counts?: { total: number; open: number; resolved: number };
  mention_candidates: string[];
  pending_mentions: string[];
}

export interface ProposalDiffWire {
  before: string;
  after: string;
  original: { before: string; after: string } | null;
  /** `'unavailable'` = the server could not run the merge at all. */
  mergeable: 'clean' | 'conflict' | 'stale' | 'unavailable' | null;
}

export interface InviteWire {
  token: string;
  display_name: string | null;
  role: Role;
  kind: 'admin' | 'named' | 'generic';
  note: string | null;
  created_at: number;
  created_by_name: string;
  url: string;
}

export interface UploadResponseWire {
  uid: string;
  name: string | null;
  admin_invite: { token: string; url: string; display_name: string };
  default_theme: string;
  format: DocumentFormat;
  /**
   * What the server actually applied. Absent from instances that predate
   * the flag, where a document is always readable by URL — so only an
   * explicit `true` means the token-free link opens nothing.
   */
  invite_only?: boolean;
  password?: string;
}

export interface HistoryEntryWire {
  oid: string;
  action: 'upload' | 'update' | 'restore' | 'accept-proposal' | 'unknown';
  actor: { client_id: string | null; display_name: string | null };
  timestamp: number;
  restored_from_oid: string | null;
  proposal: { id: string; author: { display_name: string }; summary: string } | null;
}
