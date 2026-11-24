import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import type { OwnerKeyDraft } from "../../lib/spaces/owner-key";
import { createOwnerKey, downloadOwnerKey } from "../../lib/spaces/owner-key";
import { KeepKeyDialog } from "./KeepKeyDialog";

/** Makes a key on this device; `draft` is set until it is saved or discarded. */
export function useNewBackupKey() {
  const [draft, setDraft] = useState<OwnerKeyDraft | null>(null);
  const create = useSave({ save: () => createOwnerKey(), onSaved: setDraft });
  return { create, draft, discard: () => setDraft(null) };
}

/**
 * Where a new backup key is saved before the Space is sealed to it. The Space is given the key
 * only after its owner has downloaded or copied the file, so a key nobody kept is never used.
 */
export function BackupKeyDialog({
  draft,
  onClose,
  onSaved,
}: {
  draft: OwnerKeyDraft;
  /** The dialog ended, saved or not. */
  onClose: () => void;
  /** The Space was given the key; called before `onClose`. */
  onSaved?: () => void;
}) {
  const { t } = useLingui();
  const keysKey = useSpaceQueries().recordLedger.keys.queryOptions().queryKey;

  return (
    <KeepKeyDialog
      testId="backup-key-dialog"
      title={<Trans>Save your backup key</Trans>}
      description={<Trans>We don't keep a copy. Without it, your backups can't be opened.</Trans>}
      file={draft.file}
      onDownload={() => downloadOwnerKey(draft)}
      save={(rpc) => rpc.recordLedger.addKey({ recipient: draft.recipient })}
      stale={[keysKey]}
      failure={t`Couldn't save your backup key`}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}
