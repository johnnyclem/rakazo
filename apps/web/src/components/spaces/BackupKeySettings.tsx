import { Trans, useLingui } from "@lingui/react/macro";
import { MAX_OWNER_KEYS } from "@rakazo/contracts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { ConfirmDialog } from "../ConfirmDialog";
import { SettingsGroup, SettingsRow } from "../settings/SettingsRows";
import { BackupKeyDialog, useNewBackupKey } from "./BackupKeyDialog";

/** The start and end of a key, enough to tell it from another. */
const shortKey = (recipient: string) => `${recipient.slice(0, 8)}…${recipient.slice(-6)}`;

/**
 * The key a Space's backups are sealed to. Its owner makes it here, on this device, and keeps the
 * private half; the server only ever holds the public half.
 */
export function BackupKeySettings() {
  const { t } = useLingui();
  const keysOptions = useSpaceQueries().recordLedger.keys.queryOptions();
  const keysQuery = useQuery(keysOptions);
  const { create, draft, discard } = useNewBackupKey();
  const [removing, setRemoving] = useState<string | null>(null);
  const remove = useSave({
    save: (recipient: string, rpc) => rpc.recordLedger.removeKey({ recipient }),
    stale: [keysOptions.queryKey],
    onSaved: () => setRemoving(null),
    onFailed: () => setRemoving(null),
  });

  const data = keysQuery.data;
  const shownError = create.error
    ? errorText(create.error, t`Couldn't create a key`)
    : remove.error
      ? errorText(remove.error, t`Couldn't remove your backup key`)
      : keysQuery.isError
        ? errorText(keysQuery.error, t`Couldn't load your backup key`)
        : null;
  const hasKey = (data?.keys.length ?? 0) > 0;
  // The main action while there is no key; afterwards a second key is a rare, quiet one.
  const createButton = (
    <Button
      size="sm"
      variant={hasKey ? "ghost" : "default"}
      disabled={create.pending}
      onClick={() => create.run()}
    >
      <Trans>Create key</Trans>
    </Button>
  );

  return (
    <div data-testid="backup-key-settings" className="space-y-2">
      {data ? (
        <SettingsGroup
          title={t`Backup key`}
          action={hasKey && data.keys.length < MAX_OWNER_KEYS ? createButton : undefined}
        >
          {data.keys.length === 0 ? (
            <SettingsRow
              label={<Trans>Seals your backups so only you can open them.</Trans>}
              control={createButton}
            />
          ) : (
            data.keys.map((key) => {
              const name = key.label ?? shortKey(key.recipient);
              return (
                <SettingsRow
                  key={key.recipient}
                  label={
                    <>
                      {key.label ? <p className="break-words">{key.label}</p> : null}
                      <p className="font-mono text-body-sm text-muted-foreground">
                        {shortKey(key.recipient)}
                      </p>
                    </>
                  }
                  control={
                    // Rare, so it waits in a menu, as for a member.
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        aria-label={t`Actions for ${name}`}
                        disabled={remove.pending}
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground"
                          />
                        }
                      >
                        <MoreHorizontal />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-auto min-w-36">
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setRemoving(key.recipient)}
                        >
                          <Trans>Remove</Trans>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  }
                />
              );
            })
          )}
        </SettingsGroup>
      ) : null}
      {data?.earlier ? (
        <p className="px-1 text-body-sm text-muted-foreground">
          <Trans>Existing backups can still be opened by the server.</Trans>
        </p>
      ) : null}
      {shownError ? (
        <p role="alert" className="px-1 text-body-sm text-destructive">
          {shownError}
        </p>
      ) : null}
      {draft ? <BackupKeyDialog draft={draft} onClose={discard} /> : null}
      {removing ? (
        <ConfirmDialog
          title={t`Remove backup key?`}
          description={
            data?.keys.length === 1 ? (
              <Trans>The server will be able to open your backups again.</Trans>
            ) : undefined
          }
          busy={remove.pending}
          confirmLabel={<Trans>Remove</Trans>}
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove.run(removing)}
        />
      ) : null}
    </div>
  );
}
