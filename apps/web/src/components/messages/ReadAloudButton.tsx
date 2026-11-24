import { useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { Pause, Play, Square } from "lucide-react";

/** Starts, pauses and resumes one reply's reading; a voice that cannot pause shows stop. */
export function ReadAloudButton({
  speaking,
  paused,
  pausable,
  disabled,
  onClick,
  className,
}: {
  speaking: boolean;
  paused: boolean;
  pausable: boolean;
  disabled: boolean;
  onClick: () => void;
  className?: string;
}) {
  const { t } = useLingui();
  const label = !speaking
    ? t`Speak this reply`
    : paused
      ? t`Resume speaking`
      : pausable
        ? t`Pause speaking`
        : t`Stop speaking`;
  const Icon = !speaking || paused ? Play : pausable ? Pause : Square;
  return (
    <Button
      variant="text"
      size="icon-xs"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={className}
    >
      <Icon aria-hidden />
    </Button>
  );
}
