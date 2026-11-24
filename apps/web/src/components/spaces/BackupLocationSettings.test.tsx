// @vitest-environment jsdom

import { flush } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const WRITER = "fake-writer-principal";
const PLACE = "place-aaaa";
const OTHER = "place-bbbb";

type Anchor = {
  label: string | null;
  writer: string | null;
  destination: string | null;
  status: { streams: number; behind: number; error: "not_allowed" | "failed" | null } | null;
  provision: { offered: boolean; state: "pending" | "ready" | "failed" | null };
};
type Keys = {
  keys: Array<{ recipient: string; label: string | null; createdAt: string }>;
  earlier: boolean;
};
const OWNER_KEY = "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw";
const none: Anchor = {
  label: "Place",
  writer: WRITER,
  destination: null,
  status: null,
  provision: { offered: false, state: null },
};
/** A Space whose owner can have a place made for them. */
const makeable: Anchor = { ...none, provision: { offered: true, state: null } };
const named = (destination: string, status: Anchor["status"] = null): Anchor => ({
  ...none,
  destination,
  status,
});
const withKey: Keys = {
  keys: [
    { recipient: `age1${"q".repeat(58)}`, label: null, createdAt: "2026-11-16T00:00:00.000Z" },
  ],
  earlier: false,
};

const recordLedger = vi.hoisted(() => ({
  keys: vi.fn(),
  anchor: vi.fn(),
  setAnchor: vi.fn(),
  clearAnchor: vi.fn(),
  provision: vi.fn(),
}));
const ownerIdentity = vi.hoisted(() => ({ create: vi.fn(), download: vi.fn() }));
/** The space each write named. */
const wrote = vi.hoisted(() => [] as (string | null)[]);
vi.mock("../../lib/query/rpc", () => {
  const clientFor = (spaceId: string | null) => ({
    recordLedger: {
      keys: () => recordLedger.keys(),
      anchor: () => recordLedger.anchor(),
      setAnchor: (input: unknown) => {
        wrote.push(spaceId);
        return recordLedger.setAnchor(input);
      },
      clearAnchor: () => {
        wrote.push(spaceId);
        return recordLedger.clearAnchor();
      },
      provision: (input: unknown) => {
        wrote.push(spaceId);
        return recordLedger.provision(input);
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

vi.mock("../../lib/spaces/owner-identity", () => ({
  createOwnerIdentity: () => ownerIdentity.create(),
  downloadOwnerIdentity: (draft: unknown) => ownerIdentity.download(draft),
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
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const ButtonLike = ({
    children,
    onClick,
    disabled,
    type,
    "aria-label": label,
  }: ComponentProps<"button">) => (
    <button
      type={type === "submit" ? "submit" : "button"}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
  return {
    Button: ButtonLike,
    Input: (props: ComponentProps<"input">) => (
      <input
        aria-label={props["aria-label"]}
        maxLength={props.maxLength}
        value={props.value}
        onChange={props.onChange}
      />
    ),
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
  };
});

import { SpaceRpcProvider } from "../../lib/query/space-rpc";
import { BackupLocationSettings } from "./BackupLocationSettings";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
/** What the server holds, so a read after a write sees it. */
let anchor: Anchor;
let keys: Keys;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  wrote.length = 0;
  anchor = none;
  keys = withKey;
  recordLedger.keys.mockImplementation(async () => keys);
  recordLedger.anchor.mockImplementation(async () => anchor);
  recordLedger.setAnchor.mockImplementation(async ({ destination }: { destination: string }) => {
    anchor = named(destination);
    return anchor;
  });
  recordLedger.clearAnchor.mockImplementation(async () => {
    anchor = none;
    return anchor;
  });
  recordLedger.provision.mockImplementation(async () => {
    anchor = { ...none, provision: { offered: false, state: "pending" } };
    return anchor;
  });
  ownerIdentity.create.mockResolvedValue({
    ownerKey: OWNER_KEY,
    file: "-----BEGIN PRIVATE KEY-----\n",
  });
  clipboard.copy.mockResolvedValue(true);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

/** Query results reach React on a later tick, so wait for the screen to show them. */
const settled = (check: () => void) => act(async () => vi.waitFor(check));

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SpaceRpcProvider spaceId="space-window">
          <BackupLocationSettings />
        </SpaceRpcProvider>
      </QueryClientProvider>,
    ),
  );
  // Both reads were answered, whether or not the screen has anything to show for them.
  await settled(() => {
    expect(recordLedger.anchor).toHaveBeenCalled();
    expect(recordLedger.keys).toHaveBeenCalled();
    expect(client.isFetching()).toBe(0);
  });
  // React shows what the reads returned a tick later: without this, "nothing is shown" proves nothing.
  await act(async () => flush());
}

function button(label: string) {
  const found = [...container.querySelectorAll("button")]
    .filter((item) => item.textContent === label || item.getAttribute("aria-label") === label)
    .at(-1);
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}
const hasButton = (label: string) =>
  [...container.querySelectorAll("button")].some(
    (item) => item.textContent === label || item.getAttribute("aria-label") === label,
  );
const click = (label: string) => act(async () => button(label).click());
const dialog = () => container.querySelector('[role="dialog"]');
const input = () => dialog()!.querySelector("input") as HTMLInputElement;
const settings = () => container.querySelector('[data-testid="backup-location-settings"]');

/** Types into the dialog's field the way a person does, so React sees an input event. */
async function type(value: string) {
  await act(async () => {
    const field = input();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const submit = () =>
  act(async () => {
    dialog()!.querySelector("form")!.requestSubmit();
  });

it("offers nothing where the ledger cannot keep a copy somewhere of the owner's own", async () => {
  anchor = { ...none, label: null, writer: null };
  await render();
  expect(settings()).toBeNull();
  expect(container.textContent).toBe("");
});

it("waits until the owner has a key, unless a place is already named", async () => {
  keys = { keys: [], earlier: false };
  await render();
  expect(settings()).toBeNull();
  act(() => root.unmount());

  anchor = named(PLACE);
  client.clear();
  root = createRoot(container);
  await render();
  expect(settings()?.textContent).toContain(PLACE);
});

it("names a place for the Space the settings are open on, and then says which ID to allow there", async () => {
  recordLedger.setAnchor.mockImplementation(async ({ destination }: { destination: string }) => {
    // The owner has not allowed the ledger at their place yet.
    anchor = named(destination, { streams: 1, behind: 1, error: "not_allowed" });
    return anchor;
  });
  await render();
  await settled(() => expect(settings()?.textContent).toContain("Place"));

  await click("Set");
  // Only the field: what to allow is said once there is a place to allow it at.
  expect(dialog()?.textContent).not.toContain(WRITER);
  expect((button("Save") as HTMLButtonElement).disabled).toBe(true);
  expect(recordLedger.setAnchor).not.toHaveBeenCalled();

  await type(`  ${PLACE}  `);
  await submit();

  expect(recordLedger.setAnchor).toHaveBeenCalledExactlyOnceWith({ destination: PLACE });
  expect(wrote).toEqual(["space-window"]);
  await settled(() => expect(dialog()).toBeNull());
  await settled(() => expect(settings()?.textContent).toContain(PLACE));
  expect(hasButton("Set")).toBe(false);
  expect(settings()?.textContent).toContain(WRITER);
  await click("Copy ID");
  expect(clipboard.copy).toHaveBeenCalledExactlyOnceWith(WRITER);
});

it("keeps the dialog, with the reason, when the place is refused", async () => {
  await render();
  await click("Set");
  await type("Not A Place");
  recordLedger.setAnchor.mockRejectedValueOnce(new Error("That is not a valid place"));

  await submit();

  await settled(() => expect(dialog()?.textContent).toContain("That is not a valid place"));
  expect(anchor.destination).toBeNull();
  await type(PLACE);
  await submit();
  await settled(() => expect(dialog()).toBeNull());
  expect(anchor.destination).toBe(PLACE);
});

it("gives up nothing when the dialog is closed without saving", async () => {
  await render();
  await click("Set");
  await type(PLACE);

  await click("Close");

  expect(dialog()).toBeNull();
  expect(recordLedger.setAnchor).not.toHaveBeenCalled();
});

it("says nothing about a place that is working", async () => {
  anchor = named(PLACE, { streams: 3, behind: 0, error: null });
  await render();
  await settled(() => expect(settings()?.textContent).toContain(PLACE));
  for (const problem of ["Catching up", "Can't reach", "Not allowed", WRITER]) {
    expect(settings()?.textContent).not.toContain(problem);
  }
});

it("says what is wrong only when something is", async () => {
  anchor = named(PLACE, { streams: 3, behind: 2, error: null });
  await render();
  await settled(() => expect(settings()?.textContent).toContain("Catching up"));
  act(() => root.unmount());

  anchor = named(PLACE, { streams: 3, behind: 3, error: "failed" });
  client.clear();
  root = createRoot(container);
  await render();
  await settled(() => expect(settings()?.textContent).toContain("Can't reach it right now."));
  expect(settings()?.textContent).not.toContain(WRITER);
});

it("shows the ID to allow, and copies it, while the place does not allow writing yet", async () => {
  anchor = named(PLACE, { streams: 3, behind: 3, error: "not_allowed" });
  await render();
  await settled(() => expect(settings()?.textContent).toContain("Not allowed to write there yet"));
  expect(settings()?.textContent).toContain(WRITER);

  await click("Copy ID");
  expect(clipboard.copy).toHaveBeenCalledExactlyOnceWith(WRITER);
});

it("changes the place, offering to save only another", async () => {
  anchor = named(PLACE);
  await render();
  await settled(() => expect(settings()?.textContent).toContain(PLACE));

  await click("Change");
  expect(input().value).toBe(PLACE);
  expect((button("Save") as HTMLButtonElement).disabled).toBe(true);

  await type(OTHER);
  await submit();

  expect(recordLedger.setAnchor).toHaveBeenCalledExactlyOnceWith({ destination: OTHER });
  await settled(() => expect(dialog()).toBeNull());
  await settled(() => expect(settings()?.textContent).toContain(OTHER));
});

it("removes the place without asking, and offers to name one again", async () => {
  anchor = named(PLACE);
  await render();
  await settled(() => expect(settings()?.textContent).toContain(PLACE));

  await click("Remove");

  expect(recordLedger.clearAnchor).toHaveBeenCalledTimes(1);
  expect(wrote).toEqual(["space-window"]);
  await settled(() => expect(button("Set")).toBeTruthy());
  expect(settings()?.textContent).not.toContain(PLACE);
});

it("says so when the place cannot be removed", async () => {
  anchor = named(PLACE);
  await render();
  await settled(() => expect(settings()?.textContent).toContain(PLACE));
  recordLedger.clearAnchor.mockRejectedValueOnce(new Error("Only the Space's owner can do that"));

  await click("Remove");

  await settled(() => expect(container.textContent).toContain("Only the Space's owner"));
  expect(settings()?.textContent).toContain(PLACE);
});

it("offers to create a place beside setting one, as the main choice, where one can be made", async () => {
  anchor = makeable;
  await render();
  await settled(() => expect(settings()?.textContent).toContain("Place"));

  expect(hasButton("Create")).toBe(true);
  expect(hasButton("Set")).toBe(true);
});

it("offers only Set where a place cannot be made", async () => {
  await render();
  await settled(() => expect(settings()?.textContent).toContain("Place"));

  expect(hasButton("Create")).toBe(false);
  expect(hasButton("Set")).toBe(true);
});

it("makes a key on this device and asks for a place only once the key is kept", async () => {
  anchor = makeable;
  await render();
  await settled(() => expect(hasButton("Create")).toBe(true));

  await click("Create");
  expect(ownerIdentity.create).toHaveBeenCalledTimes(1);
  expect(dialog()?.textContent).toContain("Save your key");
  // Making a key tells the server nothing, and nothing is asked for yet.
  expect(recordLedger.provision).not.toHaveBeenCalled();
  expect((button("Done") as HTMLButtonElement).disabled).toBe(true);

  await click("Download");
  expect(ownerIdentity.download).toHaveBeenCalledTimes(1);
  expect((button("Done") as HTMLButtonElement).disabled).toBe(false);
  await click("Done");

  // The server is given the public half alone, for the Space the settings are open on.
  expect(recordLedger.provision).toHaveBeenCalledExactlyOnceWith({ ownerKey: OWNER_KEY });
  expect(JSON.stringify(recordLedger.provision.mock.calls)).not.toContain("PRIVATE");
  expect(wrote).toEqual(["space-window"]);
  await settled(() => expect(dialog()).toBeNull());
  await settled(() => expect(settings()?.textContent).toContain("Creating…"));
  expect(hasButton("Create")).toBe(false);
  expect(hasButton("Set")).toBe(false);
});

it("asks for nothing when the key is not kept", async () => {
  anchor = makeable;
  await render();
  await settled(() => expect(hasButton("Create")).toBe(true));
  await click("Create");
  await click("Download");

  await click("Close");

  expect(dialog()).toBeNull();
  expect(recordLedger.provision).not.toHaveBeenCalled();
  expect(hasButton("Create")).toBe(true);
});

it("keeps the key dialog, with the reason, when the server will not make a place", async () => {
  anchor = makeable;
  await render();
  await settled(() => expect(hasButton("Create")).toBe(true));
  await click("Create");
  await click("Download");
  recordLedger.provision.mockRejectedValueOnce(
    new Error("Making a place for your backups needs a paid plan"),
  );

  await click("Done");

  await settled(() => expect(dialog()?.textContent).toContain("needs a paid plan"));
  expect((button("Done") as HTMLButtonElement).disabled).toBe(false);
});

it("says so when a key cannot be made, and goes no further", async () => {
  anchor = makeable;
  ownerIdentity.create.mockRejectedValueOnce(new Error("Ed25519 is not supported"));
  await render();
  await settled(() => expect(hasButton("Create")).toBe(true));

  await click("Create");

  await settled(() => expect(container.textContent).toContain("Ed25519 is not supported"));
  expect(dialog()).toBeNull();
  expect(recordLedger.provision).not.toHaveBeenCalled();
});

it("shows a place being made even before the owner has a backup key, and nothing to press", async () => {
  keys = { keys: [], earlier: false };
  anchor = { ...none, provision: { offered: false, state: "pending" } };
  await render();

  await settled(() => expect(settings()?.textContent).toContain("Creating…"));
  expect(container.querySelectorAll("button")).toHaveLength(0);
});

it("says a place could not be made, and still lets the owner set one themselves", async () => {
  anchor = { ...none, provision: { offered: false, state: "failed" } };
  await render();

  await settled(() => expect(settings()?.textContent).toContain("Couldn't create it"));
  expect(hasButton("Set")).toBe(true);
  expect(hasButton("Create")).toBe(false);
});

it("shows the place as any other once it is ready", async () => {
  anchor = { ...none, provision: { offered: false, state: "pending" } };
  await render();
  await settled(() => expect(settings()?.textContent).toContain("Creating…"));

  anchor = { ...named(PLACE), provision: { offered: false, state: "ready" } };
  await act(async () => client.invalidateQueries());

  await settled(() => expect(settings()?.textContent).toContain(PLACE));
  expect(settings()?.textContent).not.toContain("Creating…");
});
