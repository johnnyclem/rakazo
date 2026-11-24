import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { BackupKeyDialog, useNewBackupKey } from "../../components/spaces/BackupKeyDialog";
import { errorText } from "../../lib/query/user-error";

/**
 * The first step for a new account on a deployment that keeps a ledger of its backups. Nothing is
 * recorded yet, so a key made now seals everything; skipping leaves it for Settings.
 */
export function KeyStep({ onDone }: { onDone: () => void }) {
  const { t } = useLingui();
  const { create, draft, discard } = useNewBackupKey();
  return (
    <div data-testid="onboarding-key">
      <h1 className="text-display font-medium text-foreground">
        <Trans>Backup key</Trans>
      </h1>
      <p className="mt-4 text-body text-muted-foreground">
        <Trans>Seals your backups so only you can open them.</Trans>
      </p>
      {create.error ? (
        <p role="alert" className="mt-4 text-body-sm text-destructive">
          {errorText(create.error, t`Couldn't create a key`)}
        </p>
      ) : null}
      <div className="mt-8 flex items-center gap-2">
        <Button disabled={create.pending} onClick={() => create.run()}>
          <Trans>Create key</Trans>
        </Button>
        <Button variant="ghost" onClick={onDone}>
          <Trans>Skip</Trans>
        </Button>
      </div>
      {draft ? <BackupKeyDialog draft={draft} onClose={discard} onSaved={onDone} /> : null}
    </div>
  );
}
