import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/tmp/mock-agent",
  DynamicBorder: class { constructor(..._args: unknown[]) {} },
}));

vi.mock("@earendil-works/pi-tui", () => ({
  Container: class {
    addChild(_child: unknown) {}
    render() { return []; }
    invalidate() {}
  },
  Input: class {
    focused = false;
    onSubmit: ((value: string) => void) | undefined;
    onEscape: (() => void) | undefined;
    handleInput(_data: string) {}
  },
  SelectList: class {
    onSelect: ((item: { value: string }) => void) | undefined;
    onCancel: (() => void) | undefined;
    constructor(_items: unknown[], _height: number, _theme: unknown) {}
    handleInput(_data: string) {}
  },
  Text: class { constructor(..._args: unknown[]) {} },
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => JSON.stringify({
    version: 1,
    profiles: { alpha: { order: 0 } },
  })),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

import extension from "../index.js";
import type { PiLike } from "./types.js";

function mockPi(): PiLike {
  return {
    appendEntry: vi.fn(),
    getThinkingLevel: vi.fn(() => "medium" as const),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    setModel: vi.fn(async () => true),
    setThinkingLevel: vi.fn(),
    on: vi.fn(),
  };
}

describe("package extension", () => {
  it("creates typed profiles without dropping global config and adds them to the active cycle", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      version: 1,
      defaultProfile: "existing",
      shortcut: "ctrl+tab",
      cycle: ["existing"],
      profiles: {
        existing: {
          order: 3,
          orchestrator: { model: { provider: "openai", id: "gpt-4" } },
        },
      },
    }));

    const pi = mockPi();
    extension(pi);
    const handler = (vi.mocked(pi.registerCommand).mock.calls as any[]).find(
      ([name]: [string]) => name === "profiles",
    )[1].handler as (args: string, ctx: any) => Promise<void>;
    const custom = vi
      .fn()
      .mockResolvedValueOnce("__CREATE__")
      .mockResolvedValueOnce("new-profile");
    const ctx = {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: { find: vi.fn(() => ({ id: "claude" })) },
      sessionManager: { getSessionId: () => "session-1" },
      ui: { custom, notify: vi.fn(), setStatus: vi.fn() },
    };

    await handler("", ctx);

    expect(fs.writeFile).toHaveBeenCalledWith(
      "/tmp/mock-agent/pi-profiles/config.json",
      expect.stringContaining('"new-profile"'),
    );
    const saved = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0]![1] as string);
    expect(saved).toMatchObject({
      defaultProfile: "existing",
      shortcut: "ctrl+tab",
      cycle: ["existing", "new-profile"],
    });
    expect(saved.profiles["new-profile"]).toEqual({
      order: 4,
      orchestrator: {
        model: { provider: "anthropic", id: "claude" },
        effort: "medium",
      },
    });

    const shortcutHandler = vi.mocked(pi.registerShortcut).mock.calls[0]![1]
      .handler as (shortcutCtx: any) => Promise<void>;
    await shortcutHandler(ctx);
    await shortcutHandler(ctx);
    expect(ctx.modelRegistry.find).toHaveBeenLastCalledWith("anthropic", "claude");
  });

  it("applies explicit profile agent routes without replacing unowned global routes", async () => {
    const syncFs = await import("node:fs");
    vi.mocked(syncFs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      profiles: { alpha: { order: 0, agents: { reviewer: { effort: "low" } } } },
    }));
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      untouched: true,
      model_profiles: { writer: { model: "anthropic/claude", effort: "high" } },
    }));
    vi.mocked(fs.writeFile).mockClear();

    const pi = mockPi();
    extension(pi);
    const handler = (vi.mocked(pi.registerCommand).mock.calls as any[]).find(
      ([name]: [string]) => name === "profiles",
    )[1].handler as (args: string, ctx: any) => Promise<void>;
    const ctx = {
      sessionManager: { getSessionId: () => "session-1" },
      modelRegistry: { find: vi.fn() },
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    };

    await handler("use alpha", ctx);

    expect(vi.mocked(fs.writeFile)).toHaveBeenCalledWith(
      "/tmp/mock-agent/subagents.json",
      expect.stringContaining('"reviewer"'),
    );
    const saved = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0]![1] as string);
    expect(saved).toMatchObject({
      untouched: true,
      model_profiles: {
        reviewer: { effort: "low" },
        writer: { model: "anthropic/claude", effort: "high" },
      },
    });
  });

  it("snapshots current global agent routes when creating a profile", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockImplementation(async (path) =>
      String(path).endsWith("subagents.json")
        ? JSON.stringify({ model_profiles: { reviewer: { model: "openai/gpt-4", effort: "low" } } })
        : JSON.stringify({ version: 1, profiles: {} }),
    );
    vi.mocked(fs.writeFile).mockClear();

    const pi = mockPi();
    extension(pi);
    const handler = (vi.mocked(pi.registerCommand).mock.calls as any[]).find(
      ([name]: [string]) => name === "profiles",
    )[1].handler as (args: string, ctx: any) => Promise<void>;
    const ctx = {
      sessionManager: { getSessionId: () => "session-1" },
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: { find: vi.fn() },
      ui: { custom: vi.fn().mockResolvedValueOnce("__CREATE__").mockResolvedValueOnce("snapshot").mockResolvedValueOnce(null), notify: vi.fn(), setStatus: vi.fn() },
    };

    await handler("", ctx);

    const saved = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0]![1] as string);
    expect(saved.profiles.snapshot.agents).toEqual({
      reviewer: { model: { provider: "openai", id: "gpt-4" }, effort: "low" },
    });
  });

  it("saves a named current configuration snapshot to the typed config store", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockImplementation(async (path) =>
      String(path).endsWith("subagents.json")
        ? JSON.stringify({ model_profiles: { reviewer: { model: "openai/gpt-4", effort: "low" } } })
        : JSON.stringify({ version: 1, profiles: {} }),
    );
    vi.mocked(fs.writeFile).mockClear();

    const pi = mockPi();
    extension(pi);
    const handler = (vi.mocked(pi.registerCommand).mock.calls as any[]).find(
      ([name]: [string]) => name === "profiles",
    )[1].handler as (args: string, ctx: any) => Promise<void>;
    const ctx = {
      sessionManager: { getSessionId: () => "session-1" },
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: { find: vi.fn() },
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    };

    await handler("save snapshot", ctx);

    expect(fs.writeFile).toHaveBeenCalledWith(
      "/tmp/mock-agent/pi-profiles/config.json",
      expect.any(String),
    );
    const saved = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0]![1] as string);
    expect(saved.profiles.snapshot).toEqual({
      order: 0,
      orchestrator: {
        model: { provider: "anthropic", id: "claude" },
        effort: "medium",
      },
      agents: {
        reviewer: { model: { provider: "openai", id: "gpt-4" }, effort: "low" },
      },
    });
  });

  it("preserves the favorite action in the typed config store", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      version: 1,
      profiles: { alpha: { order: 0 } },
    }));

    const pi = mockPi();
    extension(pi);
    const handler = (vi.mocked(pi.registerCommand).mock.calls as any[]).find(
      ([name]: [string]) => name === "profiles",
    )[1].handler as (args: string, ctx: any) => Promise<void>;
    vi.mocked(fs.writeFile).mockClear();
    const ctx = {
      modelRegistry: { find: vi.fn() },
      sessionManager: { getSessionId: () => "session-1" },
      ui: {
        custom: vi.fn().mockResolvedValueOnce("alpha").mockResolvedValueOnce("favorite").mockResolvedValueOnce(null),
        notify: vi.fn(),
        setStatus: vi.fn(),
      },
    };

    await handler("", ctx);

    expect(fs.writeFile).toHaveBeenCalledWith(
      "/tmp/mock-agent/pi-profiles/config.json",
      expect.stringContaining('"defaultProfile": "alpha"'),
    );
  });

  it("imports typed profile strings into the authoritative config without legacy storage", async () => {
    const fs = await import("node:fs/promises");
    const pi = mockPi();
    extension(pi);
    const handler = (vi.mocked(pi.registerCommand).mock.calls as any[]).find(
      ([name]: [string]) => name === "profiles",
    )[1].handler as (args: string, ctx: any) => Promise<void>;
    vi.mocked(fs.writeFile).mockClear();
    const payload = Buffer.from(JSON.stringify({
      _type: "piprofile",
      version: 1,
      profile: {
        name: "beta",
        favorite: true,
        order: 9,
        orchestrator: { model: { provider: "openai", id: "gpt-4" }, effort: "high" },
        agents: { reviewer: { effort: "low" } },
      },
    })).toString("base64");
    const ctx = {
      sessionManager: { getSessionId: () => "session-1" },
      modelRegistry: { find: vi.fn() },
      ui: {
        custom: vi.fn().mockResolvedValueOnce("__IMPORT__").mockResolvedValueOnce(`piprofile:1:${payload}`).mockResolvedValueOnce(null),
        notify: vi.fn(),
        setStatus: vi.fn(),
      },
    };

    await handler("", ctx);

    const saved = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0]![1] as string);
    expect(saved.defaultProfile).toBe("beta");
    expect(saved.profiles.beta).toMatchObject({
      order: 1,
      orchestrator: { model: { provider: "openai", id: "gpt-4" }, effort: "high" },
      agents: { reviewer: { effort: "low" } },
    });
    expect(vi.mocked(fs.writeFile).mock.calls[0]![0]).toBe("/tmp/mock-agent/pi-profiles/config.json");
  });

  it("reports malformed profile imports as user-facing validation errors", async () => {
    const pi = mockPi();
    extension(pi);
    const handler = (vi.mocked(pi.registerCommand).mock.calls as any[]).find(
      ([name]: [string]) => name === "profiles",
    )[1].handler as (args: string, ctx: any) => Promise<void>;
    const ctx = {
      sessionManager: { getSessionId: () => "session-1" },
      modelRegistry: { find: vi.fn() },
      ui: {
        custom: vi.fn().mockResolvedValueOnce("__IMPORT__").mockResolvedValueOnce("piprofile:1:not-json").mockResolvedValueOnce(null),
        notify: vi.fn(),
        setStatus: vi.fn(),
      },
    };

    await handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Invalid profile string: Invalid PiProfile payload",
      "error",
    );
  });

  it("rejects malformed legacy profile routes without persisting them", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.writeFile).mockClear();
    const payload = Buffer.from(JSON.stringify({
      _type: "piprofile",
      version: 1,
      profile: {
        name: "legacy",
        orchestrator: { model: "openai/gpt-4", thinking: "unsupported" },
      },
    })).toString("base64");
    const pi = mockPi();
    extension(pi);
    const handler = (vi.mocked(pi.registerCommand).mock.calls as any[]).find(
      ([name]: [string]) => name === "profiles",
    )[1].handler as (args: string, ctx: any) => Promise<void>;
    const ctx = {
      sessionManager: { getSessionId: () => "session-1" },
      modelRegistry: { find: vi.fn() },
      ui: {
        custom: vi.fn().mockResolvedValueOnce("__IMPORT__").mockResolvedValueOnce(`piprofile:1:${payload}`).mockResolvedValueOnce(null),
        notify: vi.fn(),
        setStatus: vi.fn(),
      },
    };

    await handler("", ctx);

    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid profile string:"),
      "error",
    );
  });

  it("rejects legacy profile routes with malformed model identifiers", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.writeFile).mockClear();
    const payload = Buffer.from(JSON.stringify({
      _type: "piprofile",
      version: 1,
      profile: {
        name: "legacy",
        orchestrator: { model: "gpt-4", thinking: "medium" },
      },
    })).toString("base64");
    const pi = mockPi();
    extension(pi);
    const handler = (vi.mocked(pi.registerCommand).mock.calls as any[]).find(
      ([name]: [string]) => name === "profiles",
    )[1].handler as (args: string, ctx: any) => Promise<void>;
    const ctx = {
      sessionManager: { getSessionId: () => "session-1" },
      modelRegistry: { find: vi.fn() },
      ui: {
        custom: vi.fn().mockResolvedValueOnce("__IMPORT__").mockResolvedValueOnce(`piprofile:1:${payload}`).mockResolvedValueOnce(null),
        notify: vi.fn(),
        setStatus: vi.fn(),
      },
    };

    await handler("", ctx);

    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid profile string:"),
      "error",
    );
  });

  it("rejects legacy profile routes with extra model identifier slashes without persisting them", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.writeFile).mockClear();
    const payload = Buffer.from(JSON.stringify({
      _type: "piprofile",
      version: 1,
      profile: {
        name: "legacy",
        orchestrator: { model: "openai/gpt-4/extra", thinking: "medium" },
      },
    })).toString("base64");
    const pi = mockPi();
    extension(pi);
    const handler = (vi.mocked(pi.registerCommand).mock.calls as any[]).find(
      ([name]: [string]) => name === "profiles",
    )[1].handler as (args: string, ctx: any) => Promise<void>;
    const ctx = {
      sessionManager: { getSessionId: () => "session-1" },
      modelRegistry: { find: vi.fn() },
      ui: {
        custom: vi.fn().mockResolvedValueOnce("__IMPORT__").mockResolvedValueOnce(`piprofile:1:${payload}`).mockResolvedValueOnce(null),
        notify: vi.fn(),
        setStatus: vi.fn(),
      },
    };

    await handler("", ctx);

    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid profile string:"),
      "error",
    );
  });

  it("restores the typed default profile during session startup", async () => {
    const syncFs = await import("node:fs");
    vi.mocked(syncFs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      defaultProfile: "alpha",
      profiles: { alpha: { order: 0 } },
    }));
    const pi = mockPi();
    extension(pi);
    const start = (vi.mocked(pi.on).mock.calls as any[]).find(
      ([event]: [string]) => event === "session_start",
    )[1] as (_event: unknown, ctx: any) => Promise<void>;
    const ctx = {
      sessionManager: { getSessionId: () => "session-1" },
      modelRegistry: { find: vi.fn() },
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    };

    await start({}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-profiles", "alpha");
  });
});
