import { Trans, useLingui } from "@lingui/react/macro";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useCopyText,
} from "@rakazo/ui-web";
import { Check, Copy, Download } from "lucide-react";
import { useState } from "react";
import type { OwnerKeyDraft } from "../lib/owner-key";
import { createOwnerKey, downloadOwnerKey } from "../lib/owner-key";
import { useSave, useSpaceQueries } from "../lib/query";
import { errorText } from "../lib/user-error";

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
  const [copied, copy] = useCopyText();
  const [kept, setKept] = useState(false);
  const keysKey = useSpaceQueries().recordLedger.keys.queryOptions().queryKey;
  const add = useSave({
    save: (recipient: string, rpc) => rpc.recordLedger.addKey({ recipient }),
    stale: [keysKey],
    onSaved: () => {
      onSaved?.();
      onClose();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !add.pending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-sm" data-testid="backup-key-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Save your backup key</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>We don't keep a copy. Without it, your backups can't be opened.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          {/* One filled button at a time: this until the key is kept, then Done. */}
          <Button
            variant={kept ? "outline" : "default"}
            onClick={() => {
              downloadOwnerKey(draft);
              setKept(true);
            }}
          >
            <Download aria-hidden="true" />
            <Trans>Download</Trans>
          </Button>
          <Button
            variant="outline"
            onClick={async () => {
              if (await copy(draft.file)) setKept(true);
            }}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
          </Button>
        </div>
        {add.error ? (
          <p role="alert" className="text-body-sm text-destructive">
            {errorText(add.error, t`Couldn't save your backup key`)}
          </p>
        ) : null}
        <DialogFooter>
          <Button disabled={!kept || add.pending} onClick={() => add.run(draft.recipient)}>
            <Trans>Done</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
