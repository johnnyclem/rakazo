// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const keys = vi.hoisted(() => ({
  run: vi.fn(),
  draft: null as null | { recipient: string; file: string },
  error: null as null | Error,
  pending: false,
  discard: vi.fn(),
}));
vi.mock("../../components/spaces/BackupKeyDialog", () => ({
  useNewBackupKey: () => ({
    create: { run: keys.run, error: keys.error, pending: keys.pending },
    draft: keys.draft,
    discard: keys.discard,
  }),
  BackupKeyDialog: ({ onClose, onSaved }: { onClose: () => void; onSaved?: () => void }) => (
    <div role="dialog">
      <button
        type="button"
        onClick={() => {
          onSaved?.();
          onClose();
        }}
      >
        saved
      </button>
      <button type="button" onClick={onClose}>
        closed
      </button>
    </div>
  ),
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values);
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

import { KeyStep } from "./key-step";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onDone = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  keys.draft = null;
  keys.error = null;
  keys.pending = false;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const render = () => act(async () => root.render(<KeyStep onDone={onDone} />));
const press = (label: string) =>
  act(async () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === label)!.click(),
  );

it("says what the key is for, and makes one when asked", async () => {
  await render();
  expect(container.querySelector("h1")?.textContent).toBe("Backup key");
  expect(container.textContent).toContain("Seals your backups so only you can open them.");
  expect(container.querySelector('[role="dialog"]')).toBeNull();

  await press("Create key");
  expect(keys.run).toHaveBeenCalledTimes(1);
  expect(onDone).not.toHaveBeenCalled();
});

it("goes on, once, when the key is saved, and not when the dialog is only closed", async () => {
  keys.draft = { recipient: "age1x", file: "key file" };
  await render();
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();

  await press("closed");
  expect(keys.discard).toHaveBeenCalledTimes(1);
  expect(onDone).not.toHaveBeenCalled();

  await press("saved");
  expect(onDone).toHaveBeenCalledTimes(1);
});

it("goes on without a key when skipped", async () => {
  await render();
  await press("Skip");
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(keys.run).not.toHaveBeenCalled();
});

it("shows why a key could not be made, and holds the button while one is being made", async () => {
  keys.error = new Error("Could not load the key library");
  keys.pending = true;
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not load the key library",
  );
  expect(
    [...container.querySelectorAll("button")].find((b) => b.textContent === "Create key")!.disabled,
  ).toBe(true);
  // Skipping stays possible, so a failure never holds up signup.
  await press("Skip");
  expect(onDone).toHaveBeenCalledTimes(1);
});
