import { useMemo, useRef } from 'react';
import { IconButton, Text } from '@radix-ui/themes';
import { Cross2Icon } from '@radix-ui/react-icons';
import { type AttachedAsset, assetProxyUrl } from '../lib/api.js';

interface AssetsPanelProps {
  docUid: string;
  assets: AttachedAsset[];
  /** Ref names referenced by the current source — used to flag orphans. */
  referencedRefs: ReadonlySet<string>;
  onReplace: (refName: string, file: File) => void;
  onDelete: (refName: string) => void;
  onAdd: (file: File, refName: string) => void;
  canEdit: boolean;
}

export function AssetsPanel({
  docUid,
  assets,
  referencedRefs,
  onReplace,
  onDelete,
  onAdd,
  canEdit,
}: AssetsPanelProps) {
  const addInput = useRef<HTMLInputElement>(null);
  const sorted = useMemo(
    () => [...assets].sort((a, b) => a.ref_name.localeCompare(b.ref_name)),
    [assets],
  );

  function handleAdd(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const ref = file.name;
    onAdd(file, ref);
    e.target.value = '';
  }

  return (
    <aside className="assets-panel" aria-label="Document assets">
      <div className="assets-panel__title">Assets</div>
      {sorted.length === 0 ? (
        <Text className="assets-panel__empty" as="p">
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
                  src={assetProxyUrl(docUid, asset.ref_name)}
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
                  <ReplaceButton refName={asset.ref_name} onReplace={onReplace} />
                  <IconButton
                    variant="ghost"
                    color="gray"
                    size="1"
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
      {canEdit && (
        <label className="assets-panel__add">
          <input
            ref={addInput}
            type="file"
            style={{ display: 'none' }}
            onChange={handleAdd}
          />
          <button
            type="button"
            className="rt-Button rt-r-size-1 rt-variant-soft"
            onClick={() => addInput.current?.click()}
          >
            + Attach file
          </button>
        </label>
      )}
    </aside>
  );
}

function ReplaceButton({
  refName,
  onReplace,
}: {
  refName: string;
  onReplace: (refName: string, file: File) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <label style={{ display: 'inline-flex' }}>
      <input
        ref={ref}
        type="file"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onReplace(refName, file);
          e.target.value = '';
        }}
      />
      <button
        type="button"
        className="rt-Button rt-r-size-1 rt-variant-ghost"
        onClick={() => ref.current?.click()}
        aria-label={`Replace ${refName}`}
      >
        Replace
      </button>
    </label>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
