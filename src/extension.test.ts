import { describe, expect, it, vi } from "vitest";

// Mock the Pi SDK before importing extension
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/tmp/mock-agent",
}));

import extension from "./extension.js";
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
});
