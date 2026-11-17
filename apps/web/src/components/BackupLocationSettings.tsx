import { Trans, useLingui } from "@lingui/react/macro";
import type { RecordLedgerAnchor } from "@rakazo/contracts";
import { MAX_ANCHOR_DESTINATION_LENGTH } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  useCopyText,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { useSave, useSpaceQueries } from "../lib/query";
import { errorText } from "../lib/user-error";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

/** An identity the owner has to allow where their backups are kept, with a way to copy it. */
function WriterId({ writer }: { writer: string }) {
  const { t } = useLingui();
  const [copied, copy] = useCopyText();
  return (
    <div className="flex items-center gap-1">
      <code className="min-w-0 break-all font-mono text-body-sm text-foreground">{writer}</code>
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0 text-muted-foreground"
        aria-label={t`Copy ID`}
        onClick={() => void copy(writer)}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </Button>
    </div>
  );
}

/** What is not right with the place, said only when something is. */
function Problem({ anchor }: { anchor: RecordLedgerAnchor }) {
  const { status, writer } = anchor;
  if (!status) return null;
  if (status.error === "not_allowed") {
    return (
      <div className="space-y-1 pt-2 text-body-sm text-warning">
        <p>
          <Trans>Not allowed to write there yet. Allow this ID:</Trans>
        </p>
        {writer ? <WriterId writer={writer} /> : null}
      </div>
    );
  }
  if (status.error === "failed") {
    return (
      <p className="pt-2 text-body-sm text-muted-foreground">
        <Trans>Can't reach it right now.</Trans>
      </p>
    );
  }
  return status.behind > 0 ? (
    <p className="pt-2 text-body-sm text-muted-foreground">
      <Trans>Catching up</Trans>
    </p>
  ) : null;
}

function LocationDialog({
  anchor,
  label,
  onClose,
}: {
  anchor: RecordLedgerAnchor;
  label: string;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const anchorKey = useSpaceQueries().recordLedger.anchor.queryOptions().queryKey;
  const [draft, setDraft] = useState(anchor.destination ?? "");
  const set = useSave({
    save: (destination: string, rpc) => rpc.recordLedger.setAnchor({ destination }),
    stale: [anchorKey],
    onSaved: onClose,
  });
  const destination = draft.trim();
  const canSave = destination !== "" && destination !== anchor.destination && !set.pending;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !set.pending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-sm" data-testid="backup-location-dialog">
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) set.run(destination);
          }}
        >
          <Input
            aria-label={label}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            maxLength={MAX_ANCHOR_DESTINATION_LENGTH}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          {set.error ? (
            <p role="alert" className="text-body-sm text-destructive">
              {errorText(set.error, t`Couldn't save where your backups are kept`)}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={!canSave}>
              <Trans>Save</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Where a Space's backups are also kept, when its owner holds the place: with the key, nobody who
 * runs the server can open them or take them away. Offered once the owner has a key, and only where
 * the deployment's ledger can keep a copy somewhere of their own.
 */
export function BackupLocationSettings() {
  const { t } = useLingui();
  const recordLedger = useSpaceQueries().recordLedger;
  const anchorOptions = recordLedger.anchor.queryOptions();
  const anchorQuery = useQuery(anchorOptions);
  const keysQuery = useQuery(recordLedger.keys.queryOptions());
  const [editing, setEditing] = useState(false);
  const clear = useSave({
    save: (_input, rpc) => rpc.recordLedger.clearAnchor(),
    stale: [anchorOptions.queryKey],
  });

  const anchor = anchorQuery.data;
  const label = anchor?.label;
  const shownError = clear.error
    ? errorText(clear.error, t`Couldn't remove where your backups are kept`)
    : anchorQuery.isError
      ? errorText(anchorQuery.error, t`Couldn't load where your backups are kept`)
      : null;
  if (!anchor || !label) return shownError ? <ShownError text={shownError} /> : null;
  const offered = anchor.destination !== null || (keysQuery.data?.keys.length ?? 0) > 0;
  if (!offered) return null;

  return (
    <div data-testid="backup-location-settings" className="space-y-2">
      <SettingsGroup title={t`Backup location`}>
        {anchor.destination === null ? (
          <SettingsRow
            label={label}
            control={
              <Button size="sm" onClick={() => setEditing(true)}>
                <Trans>Set</Trans>
              </Button>
            }
          />
        ) : (
          <SettingsRow
            label={<p className="break-all font-mono text-body-sm">{anchor.destination}</p>}
            control={
              // Rare, so it waits in a menu, as for a key.
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={t`Backup location actions`}
                  disabled={clear.pending}
                  render={
                    <Button variant="ghost" size="icon-sm" className="text-muted-foreground" />
                  }
                >
                  <MoreHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-auto min-w-36">
                  <DropdownMenuItem onClick={() => setEditing(true)}>
                    <Trans>Change</Trans>
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={() => clear.run()}>
                    <Trans>Remove</Trans>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            }
          >
            <Problem anchor={anchor} />
          </SettingsRow>
        )}
      </SettingsGroup>
      {shownError ? <ShownError text={shownError} /> : null}
      {editing ? (
        <LocationDialog anchor={anchor} label={label} onClose={() => setEditing(false)} />
      ) : null}
    </div>
  );
}

function ShownError({ text }: { text: string }) {
  return (
    <p role="alert" className="px-1 text-body-sm text-destructive">
      {text}
    </p>
  );
}
