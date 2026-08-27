import { describe, expect, it, vi } from "vitest";

// Mock the Pi SDK before importing extension
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/tmp/mock-agent",
  DynamicBorder: class { constructor(..._args: any[]) {} },
}));

const tuiState = vi.hoisted(() => ({
  lists: [] as any[],
  inputs: [] as any[],
}));

vi.mock("@earendil-works/pi-tui", () => ({
  Container: class {
    children: any[] = [];
    addChild(child: any) { this.children.push(child); }
    clear() { this.children = []; }
    render() { return []; }
    invalidate() {}
  },
  DynamicBorder: class { constructor(..._args: any[]) {} },
  Input: class {
    focused = false;
    private value = "";
    constructor() { tuiState.inputs.push(this); }
    setValue(value: string) { this.value = value; }
    getValue() { return this.value; }
    handleInput(data: string) { this.value += data; }
  },
  SelectList: class {
    onSelect: ((item: any) => void) | undefined;
    onCancel: (() => void) | undefined;
    inputs: string[] = [];
    constructor(public items: any[]) { tuiState.lists.push(this); }
    handleInput(data: string) { this.inputs.push(data); }
  },
  Text: class { constructor(..._args: any[]) {} },
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(),
  readFile: vi.fn(async (filePath: string) => {
    if (filePath.endsWith("sdd-profiles-manager.json")) {
      return JSON.stringify({
        work: {
          name: "work",
          orchestrator: { model: "provider/model", thinking: "medium" },
          agents: {},
        },
        empty: {
          name: "empty",
          orchestrator: { model: "", thinking: "medium" },
          agents: {},
        },
        fav: {
          name: "fav",
          orchestrator: { model: "favprovider/favmodel", thinking: "high" },
          agents: {},
          favorite: true
        },
      });
    }
    if (
      filePath.endsWith("models.json") ||
      filePath.endsWith("subagents.json")
    ) {
      return "{}";
    }
    const error = Object.assign(new Error("not found"), { code: "ENOENT" });
    throw error;
  }),
  writeFile: vi.fn(),
}));

import extension from "./extension.js";
import profilesExtension from "../index.js";
import type { PiLike } from "./types.js";

function mockPi(overrides?: Record<string, any>): PiLike {
  return {
    appendEntry: vi.fn(),
    getThinkingLevel: vi.fn(() => "medium" as const),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    setModel: vi.fn(async () => true),
    setThinkingLevel: vi.fn(),
    on: vi.fn(),
    ...overrides,
  };
}

describe("extension", () => {
  it("registers lifecycle hooks", () => {
    const pi = mockPi();
    extension(pi);

    const onCalls = (pi.on as any).mock.calls;
    const eventNames = onCalls.map((c: any[]) => c[0]);
    expect(eventNames).toContain("session_start");
    expect(eventNames).toContain("session_shutdown");
  });

  it("registers shortcut", () => {
    const pi = mockPi();
    extension(pi);

    expect(pi.registerShortcut).toHaveBeenCalled();
  });

  it("registers /profiles command", () => {
    const pi = mockPi();
    extension(pi);

    expect(pi.registerCommand).toHaveBeenCalledWith(
      "profiles",
      expect.objectContaining({ description: expect.any(String) }),
    );
  });

  it("handles shortcut registration failure gracefully", () => {
    const pi = mockPi({
      registerShortcut: vi.fn(() => {
        throw new Error("collision");
      }),
    });

    // Should not throw
    expect(() => extension(pi)).not.toThrow();
  });

  it("session_shutdown clears state and status", async () => {
    const pi = mockPi();
    extension(pi);

    const onCalls = (pi.on as any).mock.calls;
    const shutdownHandler = onCalls.find(
      (c: any[]) => c[0] === "session_shutdown",
    )?.[1];

    expect(shutdownHandler).toBeDefined();

    const ctx = {
      sessionManager: { getSessionId: () => "session-1" },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    };

    await shutdownHandler({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-profiles", undefined);
  });

  it("ends the profiles flow after activating a profile", async () => {
    const pi = mockPi();
    profilesExtension(pi as any);
    const handler = (pi.registerCommand as any).mock.calls.find(
      (call: any[]) => call[0] === "profiles",
    )[1].handler;
    const custom = vi
      .fn()
      .mockResolvedValueOnce("work")
      .mockResolvedValueOnce("activate");
    const ctx = {
      modelRegistry: { find: vi.fn(() => ({ id: "model" })) },
      ui: { custom, notify: vi.fn(), setStatus: vi.fn() },
    };

    await handler([], ctx);

    expect(custom).toHaveBeenCalledTimes(2);
  });

  it("ends the profiles flow after activating a profile without a model", async () => {
    const pi = mockPi();
    profilesExtension(pi as any);
    const handler = (pi.registerCommand as any).mock.calls.find(
      (call: any[]) => call[0] === "profiles",
    )[1].handler;
    const custom = vi
      .fn()
      .mockResolvedValueOnce("empty")
      .mockResolvedValueOnce("activate");
    const ctx = {
      modelRegistry: { find: vi.fn() },
      ui: { custom, notify: vi.fn(), setStatus: vi.fn() },
    };

    await handler([], ctx);

    expect(custom).toHaveBeenCalledTimes(2);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Activated profile 'empty' (no orchestrator model).",
      "info",
    );
  });

  it("searches all available model labels by case-insensitive substring", async () => {
    tuiState.lists = [];
    const pi = mockPi();
    profilesExtension(pi as any);
    const handler = (pi.registerCommand as any).mock.calls.find(
      (call: any[]) => call[0] === "profiles",
    )[1].handler;
    const custom = vi
      .fn()
      .mockResolvedValueOnce("work")
      .mockResolvedValueOnce("edit")
      .mockResolvedValueOnce("orchestrator")
      .mockResolvedValueOnce("model")
      .mockImplementationOnce(async (factory: any) => {
        const view = factory(
          { requestRender: vi.fn() },
          { fg: (_color: string, text: string) => text, bold: (text: string) => text },
          { matches: (data: string, action: string) => data === action },
          () => {},
        );
        view.handleInput("MATCH");
        view.handleInput("tui.select.down");
        view.handleInput("tui.select.confirm");
        view.handleInput("tui.select.cancel");
        return null;
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("back")
      .mockResolvedValueOnce(null);
    const ctx = {
      modelRegistry: {
        find: vi.fn(),
        getAvailable: vi.fn(async () => [
          { provider: "OpenAI", id: "gpt-4o" },
          { provider: "Acme", id: "UltraMatch" },
          { provider: "cohere", id: "command-r" },
        ]),
      },
      ui: { custom, notify: vi.fn(), setStatus: vi.fn() },
    };

    await handler([], ctx);

    expect(ctx.modelRegistry.getAvailable).toHaveBeenCalledOnce();
    expect(tuiState.lists[0].items.map((item: any) => item.label)).toEqual([
      "✎ Type custom model identifier...",
      "Acme/UltraMatch",
      "cohere/command-r",
      "OpenAI/gpt-4o",
    ]);
    expect(tuiState.lists.at(-1).items.map((item: any) => item.label)).toEqual([
      "✎ Type custom model identifier...",
      "Acme/UltraMatch",
    ]);
    expect(tuiState.lists.at(-1).inputs).toEqual([
      "tui.select.down",
      "tui.select.confirm",
      "tui.select.cancel",
    ]);
  });

  it("imports and exports profiles via single versioned string, avoiding name collisions and rejecting invalid payloads", async () => {
    tuiState.lists = [];
    tuiState.inputs = [];
    const pi = mockPi();
    profilesExtension(pi as any);
    const handler = (pi.registerCommand as any).mock.calls.find(
      (call: any[]) => call[0] === "profiles",
    )[1].handler;

    const base64MalBase64 = "piprofile:1:not_json_base64_";
    const noPrefix = "somestring";

    // Unsupported version
    const payloadUnsupported = {
      _type: "piprofile",
      version: 2,
      profile: {
        name: "wrong",
        orchestrator: { model: "exported/model", thinking: "high" },
        agents: {}
      }
    };
    const strUnsupported = "piprofile:1:" + Buffer.from(JSON.stringify(payloadUnsupported)).toString("base64");

    const profileObj = {
      name: "work",
      orchestrator: { model: "exported/model", thinking: "high" },
      agents: { "sdd-apply": { model: "exported/tool", thinking: "medium" } },
    };
    const payloadValid = {
      _type: "piprofile",
      version: 1,
      profile: profileObj
    };
    const base64Valid = "piprofile:1:" + Buffer.from(JSON.stringify(payloadValid)).toString("base64");

    const custom = vi
      .fn()
      // 1. main menu (export flow)
      .mockResolvedValueOnce("work")
      // 2. action menu
      .mockResolvedValueOnce("export")
      // 3. promptInput for export string
      .mockImplementationOnce(async (factory) => {
        // execute it to hit the new Input() creation
        factory(
          null, // tui
          { fg: (_c: any, s: any) => s, bold: (s: any) => s },
          null,
          (_val: any) => {}
        );
        return null;
      })
      // 4. action menu loops again, we return null to go back
      .mockResolvedValueOnce(null)

      // 5. main menu -> __IMPORT__
      .mockResolvedValueOnce("__IMPORT__")
      // 6. promptInput for import missing prefix
      .mockImplementationOnce(async () => noPrefix)

      // 7. main menu -> __IMPORT__
      .mockResolvedValueOnce("__IMPORT__")
      // 8. promptInput for import malformed string
      .mockImplementationOnce(async () => base64MalBase64)

      // 9. main menu -> __IMPORT__
      .mockResolvedValueOnce("__IMPORT__")
      // 10. promptInput for unsupported version
      .mockImplementationOnce(async () => strUnsupported)

      // 11. main menu -> __IMPORT__
      .mockResolvedValueOnce("__IMPORT__")
      // 12. promptInput for valid string
      .mockImplementationOnce(async () => base64Valid)

      // 13. Exit profile menu
      .mockResolvedValueOnce(null);

    const ctx = {
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(async () => []) },
      ui: { custom, notify: vi.fn(), setStatus: vi.fn() },
    };

    const fs = await import("node:fs/promises");
    const writeFn = vi.mocked(fs.writeFile);
    writeFn.mockClear();

    await handler([], ctx);

    // Verify EXPORT: exact round trip format
    expect(tuiState.inputs.length).toBeGreaterThan(0);
    const exportedStr = tuiState.inputs[0].getValue();
    expect(exportedStr.startsWith("piprofile:1:")).toBe(true);
    const decoded = JSON.parse(Buffer.from(exportedStr.slice("piprofile:1:".length), "base64").toString("utf-8"));
    expect(decoded.version).toBe(1);
    expect(decoded.profile.name).toBe("work");
    expect(decoded.profile.orchestrator.model).toBe("provider/model"); // mock fs has this

    // Verify ALL INVALID INPUTS caused NO write and threw correct errors
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("String must start with piprofile:1:"),
      "error",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Unexpected token"), // from JSON parse fail
      "error",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Unsupported profile version: 2"),
      "error",
    );

    // There should be exactly ONE write for the valid import
    expect(writeFn).toHaveBeenCalledTimes(1);

    // Verify valid collision was saved with -imported
    expect(ctx.ui.notify).toHaveBeenCalledWith("Imported profile 'work-imported'", "info");
    const writeCall = writeFn.mock.calls[0];
    const savedData = JSON.parse(writeCall![1] as string);
    expect(savedData["work-imported"]).toBeDefined();
    expect(savedData["work-imported"].name).toBe("work-imported");
    expect(savedData["work-imported"].orchestrator.model).toBe("exported/model");
  });

  it("session_start auto-activates the favorite profile", async () => {
    const pi = mockPi();
    profilesExtension(pi as any);

    const onCalls = (pi.on as any).mock.calls;
    const startHandler = onCalls.find(
      (c: any[]) => c[0] === "session_start",
    )?.[1];

    expect(startHandler).toBeDefined();

    const ctx = {
      modelRegistry: { find: vi.fn(() => ({ id: "favmodel" })) },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    };

    await startHandler({}, ctx);

    // Verify applyMainModel was called with favmodel
    expect(pi.setModel).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Switched to favprovider/favmodel", "success");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-profiles", "fav");
  });
});
