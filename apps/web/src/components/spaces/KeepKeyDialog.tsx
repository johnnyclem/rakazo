import { Trans } from "@lingui/react/macro";
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
import type { QueryKey } from "@tanstack/react-query";
import { Check, Copy, Download } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { useSave } from "../../lib/query/query";
import type { RpcClient } from "../../lib/query/rpc";
import { errorText } from "../../lib/query/user-error";

/**
 * Where a new key is saved before the Space is given what it needs to use it. The Space is only
 * told once the owner has downloaded or copied the file, so a key nobody kept is never used.
 */
export function KeepKeyDialog({
  title,
  description,
  file,
  onDownload,
  save,
  stale,
  failure,
  testId,
  onClose,
  onSaved,
}: {
  title: ReactNode;
  description: ReactNode;
  /** The key file's text, which Copy puts on the clipboard. */
  file: string;
  /** Offers the key file for download. */
  onDownload: () => void;
  /** Gives the Space what it needs, once the key is kept. */
  save: (rpc: RpcClient) => Promise<unknown>;
  /** The reads that save makes out of date. */
  stale: readonly QueryKey[];
  /** What to say, in words, when the save fails and the server gave no reason. */
  failure: string;
  testId: string;
  /** The dialog ended, saved or not. */
  onClose: () => void;
  /** The Space was told; called before `onClose`. */
  onSaved?: () => void;
}) {
  const [copied, copy] = useCopyText();
  const [kept, setKept] = useState(false);
  const add = useSave({
    save: (_input, rpc) => save(rpc),
    stale,
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
      <DialogContent className="sm:max-w-sm" data-testid={testId}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          {/* One filled button at a time: this until the key is kept, then Done. */}
          <Button
            variant={kept ? "outline" : "default"}
            onClick={() => {
              onDownload();
              setKept(true);
            }}
          >
            <Download aria-hidden="true" />
            <Trans>Download</Trans>
          </Button>
          <Button
            variant="outline"
            onClick={async () => {
              if (await copy(file)) setKept(true);
            }}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
          </Button>
        </div>
        {add.error ? (
          <p role="alert" className="text-body-sm text-destructive">
            {errorText(add.error, failure)}
          </p>
        ) : null}
        <DialogFooter>
          <Button disabled={!kept || add.pending} onClick={() => add.run()}>
            <Trans>Done</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
