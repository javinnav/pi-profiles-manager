import { describe, expect, it, vi } from "vitest";

// Mock the Pi SDK before importing extension
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/tmp/mock-agent",
}));

vi.mock("@earendil-works/pi-tui", () => ({
  Container: class {},
  DynamicBorder: class {},
  Input: class {},
  SelectList: class {},
  Text: class {},
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
});
