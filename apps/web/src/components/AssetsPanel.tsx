import { useMemo, useRef } from 'react';
import { ActionIcon as IconButton, Button, Text } from '@mantine/core';
import { Cross2Icon } from '../icons.js';
import { type AttachedAsset, assetProxyUrl } from '../lib/api.js';

interface AssetsPanelProps {
  docUid: string;
  assets: AttachedAsset[];
  /** Ref names referenced by the current source — used to flag orphans. */
  referencedRefs: ReadonlySet<string>;
  onReplace: (refName: string, file: File) => void;
  onDelete: (refName: string) => void;
  canEdit: boolean;
}

export function AssetsPanel({
  docUid,
  assets,
  referencedRefs,
  onReplace,
  onDelete,
  canEdit,
}: AssetsPanelProps) {
  const sorted = useMemo(
    () => [...assets].sort((a, b) => a.ref_name.localeCompare(b.ref_name)),
    [assets],
  );

  return (
    <aside className="assets-panel" aria-label="Document assets">
      <div className="assets-panel__title">Assets</div>
      {sorted.length === 0 ? (
        <Text className="assets-panel__empty" component="p">
          No assets yet.
        </Text>
      ) : (
        sorted.map((asset) => {
          const isOrphan = !referencedRefs.has(asset.ref_name);
          return (
            <div
              key={asset.ref_name}
              className={`assets-panel__item${isOrphan ? ' assets-panel__orphan' : ''}`}
            >
              {asset.kind === 'image' ? (
                <img
                  className="assets-panel__thumb"
                  src={assetProxyUrl(docUid, asset.ref_name, asset.asset_id)}
                  alt=""
                />
              ) : (
                <div className="assets-panel__thumb" aria-hidden="true" />
              )}
              <div className="assets-panel__info">
                <span className="assets-panel__name" title={asset.ref_name}>
                  {asset.ref_name}
                </span>
                <span className="assets-panel__meta">
                  {asset.kind} · {formatBytes(asset.size)}
                  {isOrphan ? ' · unreferenced' : ''}
                </span>
              </div>
              {canEdit && (
                <>
                  <ReplaceButton
                    refName={asset.ref_name}
                    kind={asset.kind}
                    onReplace={onReplace}
                  />
                  <IconButton
                    variant="subtle"
                    color="gray"
                    size="xs"
                    onClick={() => onDelete(asset.ref_name)}
                    aria-label={`Remove ${asset.ref_name}`}
                  >
                    <Cross2Icon />
                  </IconButton>
                </>
              )}
            </div>
          );
        })
      )}
    </aside>
  );
}

function ReplaceButton({
  refName,
  kind,
  onReplace,
}: {
  refName: string;
  kind: AttachedAsset['kind'];
  onReplace: (refName: string, file: File) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // Server derives the served Content-Type from ref_name, so replacing
  // e.g. `cat.png` with a PDF would store the bytes but serve them as
  // image/png → a permanently broken image. Gate the picker by asset
  // kind; the runtime check covers drops through the underlying input
  // that `accept` can't enforce on its own.
  const accept = kind === 'image' ? 'image/*' : undefined;
  return (
    <label style={{ display: 'inline-flex' }}>
      <input
        ref={ref}
        type="file"
        style={{ display: 'none' }}
        {...(accept ? { accept } : {})}
        onChange={(e: any) => {
          const file = e.target.files?.[0];
          if (file && isKindCompatible(file, kind)) onReplace(refName, file);
          e.target.value = '';
        }}
      />
      <Button
        type="button"
        size="xs"
        variant="subtle"
        onClick={() => ref.current?.click()}
        aria-label={`Replace ${refName}`}
      >
        Replace
      </Button>
    </label>
  );
}

function isKindCompatible(file: File, kind: AttachedAsset['kind']): boolean {
  if (kind !== 'image') return true;
  // Drag-drop / clipboard files occasionally carry an empty `type`;
  // treat that as non-image so a broken replacement isn't accepted
  // silently. Legitimate image picks always populate `type` from the
  // file extension.
  return file.type.startsWith('image/');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
