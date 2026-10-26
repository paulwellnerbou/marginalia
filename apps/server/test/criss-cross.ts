import fs from 'node:fs';
import * as git from 'isomorphic-git';
import type { DocLocator, GitStore } from '../src/git-store.js';

/**
 * Re-parents a proposal onto a twin of main's merge commit with the
 * parents swapped. main and the proposal then share two best merge
 * bases, neither an ancestor of the other: a true criss-cross. iso-git
 * has no recursive strategy and refuses it, so this is the dependable
 * route to the native `git merge-file` fallback. The content is
 * untouched, so native git merges it cleanly.
 */
export async function crissCrossProposal(
  store: GitStore,
  doc: DocLocator,
  proposalId: string,
  identity: { displayName: string; clientId: string },
): Promise<void> {
  const dir = store.repoDir(doc.uid);
  const mainOid = await git.resolveRef({ fs, dir, ref: 'main' });
  const { commit: main } = await git.readCommit({ fs, dir, oid: mainOid });
  if (main.parent.length !== 2) throw new Error('main must be a two-parent merge commit');
  const twin = await git.writeCommit({
    fs,
    dir,
    commit: { ...main, parent: [main.parent[1]!, main.parent[0]!] },
  });
  const proposed = await store.readProposalTip(doc, proposalId);
  if (proposed === null) throw new Error(`missing proposal: ${proposalId}`);
  await store.createProposalBranch(doc, twin, proposalId, proposed, identity);
}
