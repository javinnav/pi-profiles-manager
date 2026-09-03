import { afterEach, describe, expect, it, vi } from "vitest";

const codingAgentState = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
}));

const tuiState = vi.hoisted(() => ({
  texts: [] as unknown[][],
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/tmp/mock-agent",
  DynamicBorder: class { constructor(..._args: unknown[]) {} },
  copyToClipboard: codingAgentState.copyToClipboard,
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
  Text: class {
    constructor(...args: unknown[]) { tuiState.texts.push(args); }
    setText(text: string) { tuiState.texts.push([text, 1, 0]); }
  },
  matchesKey: (data: string, key: string) => data === key,
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
  rename: vi.fn(),
  unlink: vi.fn(),
}));

import extension from "../index.js";
import type { PiLike } from "./types.js";

const MOCK_AGENT_DIR = "/tmp/mock-agent";
const MOCK_AGENT_CONFIG_PATH = `${MOCK_AGENT_DIR}/subagents.json`;

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

function profileUseHandler(pi: PiLike) {
  return (vi.mocked(pi.registerCommand).mock.calls as unknown[][]).find(
    ([name]) => name === "profiles",
  )![1] as { handler: (args: string, ctx: unknown) => Promise<void> };
}

function profileContext() {
  return {
    sessionManager: { getSessionId: () => "session-1" },
    modelRegistry: { find: vi.fn() },
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  };
}

afterEach(async () => {
  const fs = await import("node:fs/promises");
  for (const operation of [fs.mkdir, fs.readFile, fs.writeFile, fs.rename, fs.unlink]) {
    vi.mocked(operation).mockClear();
  }
});

describe("package extension", () => {
  it("reconciles all durable managed routes and replaces selected routes completely", async () => {
    const syncFs = await import("node:fs");
    vi.mocked(syncFs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      profiles: {
        alpha: {
          order: 0,
          agents: {
            " GENTLE-AI-EXPLORE ": {
              model: { provider: "openai", id: "new-model" },
              effort: "low",
            },
          },
        },
        other: {
          order: 1,
          agents: { "gentle-ai-review": { effort: "medium" } },
        },
      },
    }));
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      untouched: true,
      model_profiles: {
        " GENTLE-AI-EXPLORE ": {
          model: "anthropic/old-model",
          effort: "high",
          extra: "must be removed",
        },
        "GENTLE-AI-REVIEW": { model: "anthropic/review" },
        " user-route ": { arbitrary: { value: true }, effort: "max" },
      },
    }));
    vi.mocked(fs.writeFile).mockClear();
    vi.mocked(fs.rename).mockClear();

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

    expect(fs.rename).toHaveBeenCalledWith(
      expect.any(String),
      "/tmp/mock-agent/subagents.json",
    );
    const saved = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0]![1] as string);
    expect(saved).toEqual({
      untouched: true,
      model_profiles: {
        " user-route ": { arbitrary: { value: true }, effort: "max" },
        "gentle-ai-explore": {
          model: "openai/new-model",
          effort: "low",
        },
      },
    });
  });

  it("removes stale model and effort values for null and inherit routes", async () => {
    const syncFs = await import("node:fs");
    vi.mocked(syncFs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      profiles: {
        alpha: {
          order: 0,
          agents: {
            effortOnly: { model: null, effort: "low" },
            modelOnly: { model: { provider: "openai", id: "new" }, effort: "inherit" },
            empty: { model: null, effort: "inherit" },
          },
        },
      },
    }));
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      model_profiles: {
        effortonly: { model: "anthropic/old-effort", effort: "high" },
        modelonly: { model: "anthropic/old-model", effort: "high" },
        empty: { model: "anthropic/old-empty", effort: "high" },
      },
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

    const saved = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0]![1] as string);
    expect(saved.model_profiles).toEqual({
      effortonly: { effort: "low" },
      modelonly: { model: "openai/new" },
    });
  });

  it("preserves unowned routes and top-level settings without routing the orchestrator", async () => {
    const syncFs = await import("node:fs");
    vi.mocked(syncFs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      profiles: {
        alpha: {
          order: 0,
          orchestrator: {
            model: { provider: "openai", id: "orchestrator" },
            effort: "high",
          },
        },
      },
    }));
    const fs = await import("node:fs/promises");
    const global = {
      custom_setting: { enabled: true },
      model_profiles: {
        external: { model: "anthropic/external", effort: "low", extra: 7 },
      },
    };
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(global));
    vi.mocked(fs.writeFile).mockClear();

    const pi = mockPi();
    extension(pi);
    const handler = (vi.mocked(pi.registerCommand).mock.calls as any[]).find(
      ([name]: [string]) => name === "profiles",
    )[1].handler as (args: string, ctx: any) => Promise<void>;
    const ctx = {
      sessionManager: { getSessionId: () => "session-1" },
      modelRegistry: { find: vi.fn(() => ({ provider: "openai", id: "orchestrator" })) },
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    };

    await handler("use alpha", ctx);

    const saved = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0]![1] as string);
    expect(saved).toEqual(global);
    expect(pi.setModel).toHaveBeenCalled();
  });

  it.each([
    ["non-ENOENT read errors", Object.assign(new Error("permission denied"), { code: "EACCES" })],
    ["malformed JSON", "not json"],
    ["parsed non-object JSON", "[]"],
  ])("rejects %s before writing runtime configuration", async (_label, failure) => {
    const syncFs = await import("node:fs");
    vi.mocked(syncFs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      profiles: { alpha: { order: 0, agents: { reviewer: { effort: "low" } } } },
    }));
    const fs = await import("node:fs/promises");
    const initialRuntime = JSON.stringify({
      settings: { preserve: true },
      model_profiles: {
        reviewer: { model: "anthropic/old", effort: "high" },
        external: { custom: "untouched" },
      },
    });
    let runtimeContent = initialRuntime;
    vi.mocked(fs.readFile).mockRejectedValue(
      typeof failure === "string" ? new Error(failure) : failure,
    );
    if (_label === "malformed JSON") vi.mocked(fs.readFile).mockResolvedValue("not json");
    if (_label === "parsed non-object JSON") vi.mocked(fs.readFile).mockResolvedValue("[]");
    vi.mocked(fs.writeFile).mockClear();
    vi.mocked(fs.rename).mockClear();

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

    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.rename).not.toHaveBeenCalled();
    expect(runtimeContent).toBe(initialRuntime);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("treats a missing runtime configuration as empty during activation", async () => {
    const syncFs = await import("node:fs");
    vi.mocked(syncFs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      profiles: { alpha: { order: 0, agents: { reviewer: { effort: "low" } } } },
    }));
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
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

    const saved = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0]![1] as string);
    expect(saved.model_profiles).toEqual({ reviewer: { effort: "low" } });
  });

  it("persists activation through a same-directory temp file and rename", async () => {
    const syncFs = await import("node:fs");
    vi.mocked(syncFs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      profiles: { alpha: { order: 0, agents: { reviewer: { effort: "low" } } } },
    }));
    const fs = await import("node:fs/promises");
    const initial = JSON.stringify({
      untouched: { enabled: true },
      model_profiles: { reviewer: { model: "anthropic/old", effort: "high" } },
    });
    let target = initial;
    let temp = "";
    const events: string[] = [];
    vi.mocked(fs.readFile).mockResolvedValueOnce(initial);
    vi.mocked(fs.writeFile).mockImplementationOnce(async (path: any, data: any) => {
      events.push("write");
      temp = String(data);
      expect(String(path)).not.toBe(MOCK_AGENT_CONFIG_PATH);
      expect(String(path).split("/").slice(0, -1).join("/")).toBe(MOCK_AGENT_DIR);
    });
    vi.mocked(fs.rename).mockImplementationOnce(async (from: any, to: any) => {
      events.push("rename");
      expect(String(from)).toEqual(expect.any(String));
      expect(String(to)).toBe(MOCK_AGENT_CONFIG_PATH);
      target = temp;
    });

    const pi = mockPi();
    extension(pi);
    const handler = profileUseHandler(pi).handler;
    const ctx = profileContext();

    await handler("use alpha", ctx);

    expect(fs.mkdir).toHaveBeenCalledWith(MOCK_AGENT_DIR, { recursive: true });
    expect(events).toEqual(["write", "rename"]);
    expect(fs.unlink).not.toHaveBeenCalled();
    expect(target).not.toBe(initial);
    expect(JSON.parse(target).model_profiles).toEqual({ reviewer: { effort: "low" } });
    expect(fs.rename).toHaveBeenCalledWith(
      expect.not.stringMatching(/^\/tmp\/mock-agent\/subagents\.json$/),
      MOCK_AGENT_CONFIG_PATH,
    );
  });

  it("keeps the target unchanged and reports temporary-write failures", async () => {
    const syncFs = await import("node:fs");
    vi.mocked(syncFs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      profiles: { alpha: { order: 0, agents: { reviewer: { effort: "low" } } } },
    }));
    const fs = await import("node:fs/promises");
    const initial = JSON.stringify({
      untouched: { enabled: true },
      model_profiles: { reviewer: { model: "anthropic/old", effort: "high" } },
    });
    let target = initial;
    const writeError = new Error("temporary write failed");
    vi.mocked(fs.readFile).mockResolvedValueOnce(initial);
    vi.mocked(fs.writeFile).mockRejectedValueOnce(writeError);
    vi.mocked(fs.unlink).mockResolvedValueOnce(undefined);

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

    expect(target).toBe(initial);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.unlink).toHaveBeenCalledWith(expect.any(String));
    expect(ctx.ui.notify).toHaveBeenCalledWith("temporary write failed", "error");
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("keeps the target unchanged and reports rename failures", async () => {
    const syncFs = await import("node:fs");
    vi.mocked(syncFs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      profiles: { alpha: { order: 0, agents: { reviewer: { effort: "low" } } } },
    }));
    const fs = await import("node:fs/promises");
    const initial = JSON.stringify({
      untouched: { enabled: true },
      model_profiles: { reviewer: { model: "anthropic/old", effort: "high" } },
    });
    let target = initial;
    const renameError = new Error("rename failed");
    vi.mocked(fs.readFile).mockResolvedValueOnce(initial);
    vi.mocked(fs.writeFile).mockImplementationOnce(async () => undefined);
    vi.mocked(fs.rename).mockRejectedValueOnce(renameError);
    vi.mocked(fs.unlink).mockResolvedValueOnce(undefined);

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

    expect(target).toBe(initial);
    expect(fs.rename).toHaveBeenCalled();
    expect(fs.unlink).toHaveBeenCalledWith(expect.any(String));
    expect(ctx.ui.notify).toHaveBeenCalledWith("rename failed", "error");
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("preserves the original persistence error when temp cleanup fails", async () => {
    const syncFs = await import("node:fs");
    vi.mocked(syncFs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      profiles: { alpha: { order: 0, agents: { reviewer: { effort: "low" } } } },
    }));
    const fs = await import("node:fs/promises");
    const initial = JSON.stringify({ model_profiles: { reviewer: { effort: "high" } } });
    let target = initial;
    const renameError = new Error("original rename failure");
    const cleanupError = new Error("cleanup failed");
    vi.mocked(fs.readFile).mockResolvedValueOnce(initial);
    vi.mocked(fs.writeFile).mockImplementationOnce(async () => undefined);
    vi.mocked(fs.rename).mockRejectedValueOnce(renameError);
    vi.mocked(fs.unlink).mockRejectedValueOnce(cleanupError);

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

    expect(target).toBe(initial);
    expect(fs.unlink).toHaveBeenCalledWith(expect.any(String));
    expect(ctx.ui.notify).toHaveBeenCalledWith("original rename failure", "error");
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("creates typed profiles without dropping global config and adds them to the active cycle", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      version: 1,
      defaultProfile: "existing",
      shortcut: "ctrl+shift+p",
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
      shortcut: "ctrl+shift+p",
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

    expect(vi.mocked(fs.rename)).toHaveBeenCalledWith(
      expect.any(String),
      "/tmp/mock-agent/subagents.json",
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

  it.each(["return", "escape", "a", "space"])(
    "keeps export string visible until %s dismisses it",
    async (dismissKey) => {
      const syncFs = await import("node:fs");
      vi.mocked(syncFs.readFileSync).mockReturnValue(JSON.stringify({
        version: 1,
        profiles: { alpha: { order: 0 } },
      }));
      codingAgentState.copyToClipboard.mockReset();
      codingAgentState.copyToClipboard.mockResolvedValue(undefined);
      tuiState.texts = [];

      const pi = mockPi();
      extension(pi);
      const handler = (vi.mocked(pi.registerCommand).mock.calls as any[]).find(
        ([name]: [string]) => name === "profiles",
      )[1].handler as (args: string, ctx: any) => Promise<void>;

      let confirmationView: { handleInput(data: string): void } | undefined;
      let confirmationOptions: unknown;
      let finishConfirmation: ((value: unknown) => void) | undefined;
      const custom = vi
        .fn()
        .mockResolvedValueOnce("alpha")
        .mockResolvedValueOnce("export")
        .mockImplementationOnce(async (factory: (tui: { requestRender: () => void }, theme: { fg: (color: string, text: string) => string; bold: (text: string) => string }, kb: unknown, done: (value: unknown) => void) => { handleInput(data: string): void }, options: unknown) => {
          confirmationOptions = options;
          return await new Promise((resolve) => {
            finishConfirmation = resolve;
            confirmationView = factory(
              { requestRender: vi.fn() },
              {
                fg: (_color: string, text: string) => text,
                bold: (text: string) => text,
              },
              {},
              resolve,
            );
          });
        })
        .mockResolvedValueOnce(null);
      const ctx = {
        sessionManager: { getSessionId: () => "session-1" },
        modelRegistry: { find: vi.fn() },
        ui: { custom, notify: vi.fn(), setStatus: vi.fn() },
      };

      let handlerSettled = false;
      const handling = handler("", ctx).then(() => { handlerSettled = true; });
      await vi.waitFor(() => expect(custom).toHaveBeenCalledTimes(3));

      expect(codingAgentState.copyToClipboard).toHaveBeenCalledWith(
        "piprofile:1:eyJfdHlwZSI6InBpcHJvZmlsZSIsInZlcnNpb24iOjEsInByb2ZpbGUiOnsibmFtZSI6ImFscGhhIiwib3JkZXIiOjAsImZhdm9yaXRlIjpmYWxzZX19",
      );
      expect(tuiState.texts).toContainEqual([
        "📤 Profile Export: 'alpha'",
        1,
        0,
      ]);
      expect(tuiState.texts).toContainEqual([
        "Select string below to copy:",
        1,
        0,
      ]);
      expect(tuiState.texts).toContainEqual([
        "piprofile:1:eyJfdHlwZSI6InBpcHJvZmlsZSIsInZlcnNpb24iOjEsInBy".padEnd(80, " "),
        1,
        0,
      ]);
      expect(tuiState.texts).toContainEqual([
        "b2ZpbGUiOnsibmFtZSI6ImFscGhhIiwib3JkZXIiOjAsImZhdm9yaXRlIjpm".padEnd(80, " "),
        1,
        0,
      ]);
      expect(tuiState.texts).toContainEqual([
        "YWxzZX19".padEnd(80, " "),
        1,
        0,
      ]);
      expect(tuiState.texts).toContainEqual([
        "[ Press any key or Esc to close ]",
        1,
        0,
      ]);
      expect(tuiState.texts).toContainEqual([
        "✓ Copy command sent to terminal clipboard.",
        1,
        0,
      ]);
      expect(confirmationOptions).toEqual({
        overlay: true,
        overlayOptions: { anchor: "center" },
      });
      expect(confirmationView).toBeDefined();
      expect(handlerSettled).toBe(false);

      confirmationView?.handleInput(dismissKey);
      await handling;

      expect(finishConfirmation).toBeDefined();
      expect(handlerSettled).toBe(true);
      expect(ctx.ui.notify).not.toHaveBeenCalledWith(
        "✓ Copy command sent to terminal clipboard.",
        "info",
      );
    },
  );

  it("keeps export string visible and shows error if clipboard fails", async () => {
    const syncFs = await import("node:fs");
    vi.mocked(syncFs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      profiles: { alpha: { order: 0 } },
    }));
    codingAgentState.copyToClipboard.mockReset();
    codingAgentState.copyToClipboard.mockRejectedValue(new Error("clipboard unavailable"));
    tuiState.texts = [];

    const pi = mockPi();
    extension(pi);
    const handler = (vi.mocked(pi.registerCommand).mock.calls as any[]).find(
      ([name]: [string]) => name === "profiles",
    )[1].handler as (args: string, ctx: any) => Promise<void>;
    
    let confirmationView: { handleInput(data: string): void } | undefined;
    let finishConfirmation: ((value: unknown) => void) | undefined;
    const custom = vi
      .fn()
      .mockResolvedValueOnce("alpha")
      .mockResolvedValueOnce("export")
      .mockImplementationOnce(async (factory: (tui: { requestRender: () => void }, theme: { fg: (color: string, text: string) => string; bold: (text: string) => string }, kb: unknown, done: (value: unknown) => void) => { handleInput(data: string): void }, _options: unknown) => {
        return await new Promise((resolve) => {
          finishConfirmation = resolve;
          confirmationView = factory(
            { requestRender: vi.fn() },
            {
              fg: (_color: string, text: string) => text,
              bold: (text: string) => text,
            },
            {},
            resolve,
          );
        });
      })
      .mockResolvedValueOnce(null);
    const ctx = {
      sessionManager: { getSessionId: () => "session-1" },
      modelRegistry: { find: vi.fn() },
      ui: { custom, notify: vi.fn(), setStatus: vi.fn() },
    };

    let handlerSettled = false;
    const handling = handler("", ctx).then(() => { handlerSettled = true; });
    await vi.waitFor(() => expect(custom).toHaveBeenCalledTimes(3));

    expect(tuiState.texts).toContainEqual([
      "📤 Profile Export: 'alpha'",
      1,
      0,
    ]);
    expect(tuiState.texts).toContainEqual([
      "piprofile:1:eyJfdHlwZSI6InBpcHJvZmlsZSIsInZlcnNpb24iOjEsInBy".padEnd(80, " "),
      1,
      0,
    ]);
    expect(tuiState.texts).toContainEqual([
      "b2ZpbGUiOnsibmFtZSI6ImFscGhhIiwib3JkZXIiOjAsImZhdm9yaXRlIjpm".padEnd(80, " "),
      1,
      0,
    ]);
    expect(tuiState.texts).toContainEqual([
      "YWxzZX19".padEnd(80, " "),
      1,
      0,
    ]);
    expect(tuiState.texts).toContainEqual([
      expect.stringContaining("Failed to copy: clipboard unavailable"),
      1,
      0,
    ]);
    expect(confirmationView).toBeDefined();
    expect(handlerSettled).toBe(false);

    confirmationView?.handleInput("return");
    await handling;

    expect(finishConfirmation).toBeDefined();
    expect(handlerSettled).toBe(true);
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

  it("imports typed profile strings with spaces and newlines injected", async () => {
    const fs = await import("node:fs/promises");
    const pi = mockPi();
    extension(pi);
    const handler = (vi.mocked(pi.registerCommand).mock.calls as any[]).find(
      ([name]: [string]) => name === "profiles",
    )[1].handler as (args: string, ctx: any) => Promise<void>;
    vi.mocked(fs.writeFile).mockClear();
    const payloadOriginal = Buffer.from(JSON.stringify({
      _type: "piprofile",
      version: 1,
      profile: {
        name: "gamma",
        favorite: true,
        order: 9,
        orchestrator: { model: { provider: "openai", id: "gpt-4" }, effort: "high" },
      },
    })).toString("base64");
    
    // Inject some spaces and newlines to trigger stripping logic
    const payload = `piprofile: 1 :\n ${payloadOriginal.slice(0, 10)} \n ${payloadOriginal.slice(10)}  `;

    const ctx = {
      sessionManager: { getSessionId: () => "session-1" },
      modelRegistry: { find: vi.fn() },
      ui: {
        custom: vi.fn().mockResolvedValueOnce("__IMPORT__").mockResolvedValueOnce(payload).mockResolvedValueOnce(null),
        notify: vi.fn(),
        setStatus: vi.fn(),
      },
    };

    await handler("", ctx);

    const saved = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0]![1] as string);
    expect(saved.defaultProfile).toBe("gamma");
    expect(saved.profiles.gamma).toMatchObject({
      order: 1,
      orchestrator: { model: { provider: "openai", id: "gpt-4" }, effort: "high" },
    });
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

  it("syncs from the persisted config instead of stale manager state", async () => {
    const syncFs = await import("node:fs");
    vi.mocked(syncFs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      profiles: { stale: { order: 0 } },
    }));
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      version: 1,
      profiles: { persisted: { order: 0 } },
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

    await handler("sync", ctx);

    const saved = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0]![1] as string);
    expect(saved.profiles).toEqual({ persisted: { order: 0 } });
    expect(ctx.ui.notify).toHaveBeenCalledWith("Profiles synced: +0, -0", "info");
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
      cwd: "/workspace/without-selection",
      sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
      modelRegistry: { find: vi.fn() },
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    };

    await start({}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-profiles", "alpha");
  });

  it("bulk-updates only explicitly selected subagent models after a preview confirmation", async () => {
    const syncFs = await import("node:fs");
    vi.mocked(syncFs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      profiles: {
        alpha: {
          order: 0,
          orchestrator: { effort: "medium" },
          agents: {
            reviewer: { model: { provider: "openai", id: "gpt-4" }, effort: "low" },
            writer: { effort: "medium" },
            untouched: { model: { provider: "anthropic", id: "claude" }, effort: "high" },
          },
        },
        beta: { order: 1, agents: { reviewer: { effort: "low" } } },
      },
    }));
    const fs = await import("node:fs/promises");
    vi.mocked(fs.writeFile).mockClear();
    const pi = mockPi();
    extension(pi);
    const handler = (vi.mocked(pi.registerCommand).mock.calls as any[]).find(
      ([name]: [string]) => name === "profiles",
    )[1].handler as (args: string, ctx: any) => Promise<void>;
    const custom = vi.fn()
      .mockResolvedValueOnce("alpha")
      .mockResolvedValueOnce("edit")
      .mockResolvedValueOnce("bulk-model")
      .mockResolvedValueOnce("toggle:reviewer")
      .mockResolvedValueOnce("toggle:writer")
      .mockResolvedValueOnce("confirm")
      .mockResolvedValueOnce("openai/gpt-5")
      .mockResolvedValueOnce("confirm")
      .mockResolvedValueOnce(null);
    const ctx = {
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(async () => []) },
      sessionManager: { getSessionId: () => "session-1" },
      ui: { custom, notify: vi.fn(), setStatus: vi.fn() },
    };

    await handler("", ctx);

    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0]![1] as string);
    expect(saved.profiles.alpha.agents).toEqual({
      reviewer: { model: { provider: "openai", id: "gpt-5" }, effort: "low" },
      writer: { model: { provider: "openai", id: "gpt-5" }, effort: "medium" },
      untouched: { model: { provider: "anthropic", id: "claude" }, effort: "high" },
    });
    expect(saved.profiles.alpha.orchestrator).toEqual({ effort: "medium" });
    expect(saved.profiles.beta).toEqual({ order: 1, agents: { reviewer: { effort: "low" } } });
    tuiState.texts = [];
    custom.mock.calls[7]![0](
      { requestRender: vi.fn() },
      { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      {},
      vi.fn(),
    );
    expect(tuiState.texts).toContainEqual(["Review bulk model update", 1, 0]);
  });

  it("does not persist bulk thinking changes when selection, value, or confirmation is cancelled", async () => {
    const fs = await import("node:fs/promises");
    for (const responses of [
      ["alpha", "edit", "bulk-thinking", null],
      ["alpha", "edit", "bulk-thinking", "toggle:reviewer", null],
      ["alpha", "edit", "bulk-thinking", "toggle:reviewer", "confirm", "high", null],
    ]) {
      const syncFs = await import("node:fs");
      vi.mocked(syncFs.readFileSync).mockReturnValue(JSON.stringify({
        version: 1,
        profiles: { alpha: { order: 0, agents: { reviewer: { effort: "low" } } } },
      }));
      vi.mocked(fs.writeFile).mockClear();
      const pi = mockPi();
      extension(pi);
      const handler = (vi.mocked(pi.registerCommand).mock.calls as any[]).find(
        ([name]: [string]) => name === "profiles",
      )[1].handler as (args: string, ctx: any) => Promise<void>;
      const custom = vi.fn();
      for (const response of responses) custom.mockResolvedValueOnce(response);
      custom.mockResolvedValueOnce(null);
      const ctx = {
        modelRegistry: { find: vi.fn() },
        sessionManager: { getSessionId: () => "session-1" },
        ui: { custom, notify: vi.fn(), setStatus: vi.fn() },
      };

      await handler("", ctx);

          expect(fs.writeFile).not.toHaveBeenCalled();
        }
      });

      it("restores a cwd selection before falling back to the favorite", async () => {
    const syncFs = await import("node:fs");
    vi.mocked(syncFs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      defaultProfile: "favorite",
      profiles: {
        favorite: { order: 0, orchestrator: { effort: "low" } },
        selected: { order: 1, orchestrator: { effort: "high" } },
      },
    }));
    const pi = mockPi();
    extension(pi);
    const start = (vi.mocked(pi.on).mock.calls as any[]).find(
      ([event]: [string]) => event === "session_start",
    )[1] as (_event: unknown, ctx: any) => Promise<void>;
    const ctx = {
      cwd: "/workspace/project",
      sessionManager: {
        getSessionId: () => "session-1",
        getBranch: () => [{
          type: "custom",
          customType: "pi-profiles:active",
          data: {
            profile: "selected",
            route: {},
            baseline: {},
            activatedAt: "2026-01-01T00:00:00.000Z",
            cwd: "/workspace/project",
          },
        }],
      },
      modelRegistry: { find: vi.fn() },
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    };

    await start({}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-profiles", "selected");
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");

  });
});
