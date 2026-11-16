// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const RECIPIENT = `age1${"q".repeat(58)}`;
const OTHER = `age1${"p".repeat(58)}`;

type Keys = {
  keys: Array<{ recipient: string; label: string | null; createdAt: string }>;
  earlier: boolean;
};
const held = (...recipients: string[]): Keys => ({
  keys: recipients.map((recipient) => ({
    recipient,
    label: null,
    createdAt: "2026-11-16T00:00:00.000Z",
  })),
  earlier: false,
});

const recordLedger = vi.hoisted(() => ({ keys: vi.fn(), addKey: vi.fn(), removeKey: vi.fn() }));
/** The space each write named. */
const wrote = vi.hoisted(() => [] as (string | null)[]);
vi.mock("../lib/rpc", () => {
  const clientFor = (spaceId: string | null) => ({
    recordLedger: {
      keys: () => recordLedger.keys(),
      addKey: (input: unknown) => {
        wrote.push(spaceId);
        return recordLedger.addKey(input);
      },
      removeKey: (input: unknown) => {
        wrote.push(spaceId);
        return recordLedger.removeKey(input);
      },
    },
  });
  return {
    rpc: clientFor(null),
    rpcForSpace: clientFor,
    createSpaceRpc: clientFor,
    selectedSpaceId: () => null,
  };
});

const ownerKey = vi.hoisted(() => ({
  create: vi.fn(),
  download: vi.fn(),
}));
vi.mock("../lib/owner-key", () => ({
  createOwnerKey: () => ownerKey.create(),
  downloadOwnerKey: (draft: unknown) => ownerKey.download(draft),
}));

const clipboard = vi.hoisted(() => ({ copy: vi.fn() }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (text, part, index) => `${text}${index > 0 ? String(values[index - 1]) : ""}${part}`,
      "",
    );
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});
vi.mock("@rakazo/ui-web", async () => {
  const { createContext, useContext } = await vi.importActual<typeof import("react")>("react");
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const ButtonLike = ({ children, onClick, disabled }: ComponentProps<"button">) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
  // As the real alert dialog: Cancel asks the dialog to close, and the owner decides.
  const Close = createContext<(open: boolean) => void>(() => {});
  return {
    Button: ButtonLike,
    useCopyText: () => [false, (text: string) => clipboard.copy(text)],
    // As the real dialog: its ✕ asks to close, and the owner decides.
    Dialog: ({
      open,
      children,
      onOpenChange,
    }: {
      open?: boolean;
      children?: ReactNode;
      onOpenChange?: (open: boolean) => void;
    }) =>
      open ? (
        <div role="dialog">
          <button type="button" aria-label="Close" onClick={() => onOpenChange?.(false)} />
          {children}
        </div>
      ) : null,
    // Menus are shown open: what matters here is what each item does.
    DropdownMenu: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuItem: ButtonLike,
    DropdownMenuTrigger: ({
      children,
      disabled,
      "aria-label": label,
    }: ComponentProps<"button">) => (
      <button type="button" aria-label={label} disabled={disabled}>
        {children}
      </button>
    ),
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    AlertDialog: ({
      children,
      onOpenChange,
    }: {
      children?: ReactNode;
      onOpenChange: (open: boolean) => void;
    }) => (
      <Close.Provider value={onOpenChange}>
        <div role="alertdialog">{children}</div>
      </Close.Provider>
    ),
    AlertDialogAction: ButtonLike,
    AlertDialogCancel: ({ children, disabled }: ComponentProps<"button">) => {
      const close = useContext(Close);
      return (
        <button type="button" disabled={disabled} onClick={() => close(false)}>
          {children}
        </button>
      );
    },
    AlertDialogContent: Pass,
    AlertDialogDescription: Pass,
    AlertDialogFooter: Pass,
    AlertDialogHeader: Pass,
    AlertDialogTitle: Pass,
  };
});

import { SpaceRpcProvider } from "../lib/space-rpc";
import { BackupKeySettings } from "./BackupKeySettings";

const draft = { recipient: RECIPIENT, file: "# public key\nAGE-SECRET-KEY-1TEST\n" };

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
/** What the server holds, so a read after a write sees it. */
let server: Keys;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  wrote.length = 0;
  server = held();
  recordLedger.keys.mockImplementation(async () => server);
  recordLedger.addKey.mockImplementation(async ({ recipient }: { recipient: string }) => {
    server = { ...server, keys: held(...server.keys.map((key) => key.recipient), recipient).keys };
    return server;
  });
  recordLedger.removeKey.mockImplementation(async ({ recipient }: { recipient: string }) => {
    server = { ...server, keys: server.keys.filter((key) => key.recipient !== recipient) };
    return server;
  });
  ownerKey.create.mockResolvedValue(draft);
  clipboard.copy.mockResolvedValue(true);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SpaceRpcProvider spaceId="space-window">
          <BackupKeySettings />
        </SpaceRpcProvider>
      </QueryClientProvider>,
    ),
  );
  await settled(() =>
    expect(
      container.querySelector('[data-testid="backup-key-settings"]')?.textContent,
    ).toBeTruthy(),
  );
}

/** Query results reach React on a later tick, so wait for the screen to show them. */
const settled = (check: () => void) => act(async () => vi.waitFor(check));

function button(label: string) {
  const last = [...container.querySelectorAll("button")]
    .filter((item) => item.textContent === label || item.getAttribute("aria-label") === label)
    .at(-1);
  if (!last) throw new Error(`Missing ${label}`);
  return last;
}
const click = (label: string) => act(async () => button(label).click());
const dialog = () => container.querySelector('[role="dialog"]');
const confirming = () => container.querySelector('[role="alertdialog"]');

it("makes a key on this device and gives the Space only its public half, once it is kept", async () => {
  await render();
  await settled(() => expect(button("Create key")).toBeTruthy());

  await click("Create key");
  expect(ownerKey.create).toHaveBeenCalledTimes(1);
  expect(dialog()?.textContent).toContain("Save your backup key");
  // Making a key tells the server nothing, and nothing is kept yet.
  expect(recordLedger.addKey).not.toHaveBeenCalled();
  expect((button("Done") as HTMLButtonElement).disabled).toBe(true);

  await click("Download");
  expect(ownerKey.download).toHaveBeenCalledWith(draft);
  expect((button("Done") as HTMLButtonElement).disabled).toBe(false);

  await click("Done");
  // The server is given the recipient alone, for the Space the settings are open on.
  expect(recordLedger.addKey).toHaveBeenCalledExactlyOnceWith({ recipient: RECIPIENT });
  expect(JSON.stringify(recordLedger.addKey.mock.calls)).not.toContain("SECRET");
  expect(wrote).toEqual(["space-window"]);
  await settled(() => expect(dialog()).toBeNull());
  await settled(() => expect(container.textContent).toContain("age1qqqq…qqqqqq"));
  expect(container.textContent).not.toContain("Seals your backups");
});

it("counts a copy as keeping the key only when it worked", async () => {
  await render();
  await settled(() => expect(button("Create key")).toBeTruthy());
  await click("Create key");

  clipboard.copy.mockResolvedValueOnce(false);
  await click("Copy");
  expect((button("Done") as HTMLButtonElement).disabled).toBe(true);

  await click("Copy");
  expect(clipboard.copy).toHaveBeenLastCalledWith(draft.file);
  expect((button("Done") as HTMLButtonElement).disabled).toBe(false);
});

it("gives the Space nothing when the key is not kept", async () => {
  await render();
  await settled(() => expect(button("Create key")).toBeTruthy());
  await click("Create key");
  await click("Download");

  await click("Close");

  expect(dialog()).toBeNull();
  expect(recordLedger.addKey).not.toHaveBeenCalled();
  expect(button("Create key")).toBeTruthy();
});

it("keeps the key to retry when the server refuses it", async () => {
  await render();
  await settled(() => expect(button("Create key")).toBeTruthy());
  await click("Create key");
  await click("Download");
  recordLedger.addKey.mockRejectedValueOnce(
    new Error("Only the Space's owner can manage its backup keys"),
  );

  await click("Done");

  await settled(() => expect(dialog()?.textContent).toContain("Only the Space's owner"));
  expect((button("Done") as HTMLButtonElement).disabled).toBe(false);
  await click("Done");
  await settled(() => expect(dialog()).toBeNull());
  expect(server.keys.map((key) => key.recipient)).toEqual([RECIPIENT]);
});

it("warns only about removing the last key", async () => {
  server = held(RECIPIENT, OTHER);
  await render();
  await settled(() => expect(container.textContent).toContain("age1pppp…pppppp"));

  await click("Remove");
  expect(confirming()?.textContent).toContain("Remove backup key?");
  expect(confirming()?.textContent).not.toContain("The server will be able");
  expect(recordLedger.removeKey).not.toHaveBeenCalled();
  await act(async () => button("Remove").click());
  // The button of the last row: its key is the one removed.
  expect(recordLedger.removeKey).toHaveBeenCalledExactlyOnceWith({ recipient: OTHER });
  await settled(() => expect(confirming()).toBeNull());

  await settled(() => expect(container.textContent).not.toContain("age1pppp"));
  await click("Remove");
  expect(confirming()?.textContent).toContain(
    "The server will be able to open your backups again.",
  );
  await click("Cancel");
  expect(confirming()).toBeNull();
  expect(recordLedger.removeKey).toHaveBeenCalledTimes(1);
});

it("says so when backups made before the key can still be opened by the server", async () => {
  await render();
  expect(container.textContent).not.toContain("Existing backups");
  act(() => root.unmount());

  server = { ...held(), earlier: true };
  client.clear();
  root = createRoot(container);
  await render();
  await settled(() =>
    expect(container.textContent).toContain("Existing backups can still be opened by the server."),
  );
  // The way to make a key is still offered.
  expect(button("Create key")).toBeTruthy();
});

it("stops offering a new key at the limit", async () => {
  server = held(...["q", "p", "z", "r", "y"].map((c) => `age1${c.repeat(58)}`));
  await render();
  await settled(() => expect(container.textContent).toContain("age1yyyy…yyyyyy"));
  expect([...container.querySelectorAll("button")].map((item) => item.textContent)).not.toContain(
    "Create key",
  );
});
