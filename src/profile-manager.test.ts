import { describe, expect, it, vi } from "vitest";
import { ProfileManager } from "./profile-manager.js";
import type { Config, ContextLike, PiLike } from "./types.js";

function mockPi(overrides?: Partial<PiLike>): PiLike {
  return {
    appendEntry: vi.fn(),
    getThinkingLevel: vi.fn(() => "medium" as const),
    registerCommand: vi.fn() as any,
    registerShortcut: vi.fn() as any,
    setModel: vi.fn(async () => true),
    setThinkingLevel: vi.fn(),
    on: vi.fn() as any,
    ...overrides,
  };
}

function mockCtx(
  model?: { provider: string; id: string },
  sessionId = "session-1",
): ContextLike {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [],
    },
    ui: { setStatus: vi.fn(), notify: vi.fn() },
    modelRegistry: {
      find: vi.fn((_p: string, _id: string) => ({ provider: _p, id: _id })),
      getAvailable: vi.fn(() => []),
    },
    model,
    cwd: "/tmp",
    isProjectTrusted: () => false,
  } as unknown as ContextLike;
}

function config(profiles: Record<string, any> = {}): Config {
  return {
    version: 1,
    profiles: Object.fromEntries(
      Object.entries(profiles).map(([name, p], i) => [
        name,
        { order: i, ...p },
      ]),
    ),
  };
}

describe("ProfileManager", () => {
  describe("names", () => {
    it("returns profiles sorted by order", () => {
      const mgr = new ProfileManager(mockPi());
      mgr.setConfig(
        config({
          b: { order: 2 },
          a: { order: 1 },
        }),
      );
      expect(mgr.names()).toEqual(["a", "b"]);
    });

    it("uses cycle when configured", () => {
      const mgr = new ProfileManager(mockPi());
      mgr.setConfig({
        version: 1,
        cycle: ["x", "y"],
        profiles: {
          y: { order: 1 },
          x: { order: 0 },
        },
      });
      expect(mgr.names()).toEqual(["x", "y"]);
    });
  });

  describe("use", () => {
    it("activates profile and sets status", async () => {
      const pi = mockPi();
      const ctx = mockCtx({ provider: "openai", id: "gpt-4" });
      const mgr = new ProfileManager(pi, ctx);
      mgr.setConfig(
        config({
          fast: {
            orchestrator: {
              model: { provider: "anthropic", id: "claude" },
              effort: "low",
            },
          },
        }),
      );

      const snap = await mgr.use("fast");
      expect(snap.profile).toBe("fast");
      expect(snap.route.model).toEqual({ provider: "anthropic", id: "claude" });
      expect(snap.baseline.model).toEqual({ provider: "openai", id: "gpt-4" });
      expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-profiles", "fast");
    });

    it("applies thinking level live", async () => {
      const pi = mockPi();
      const ctx = mockCtx();
      const mgr = new ProfileManager(pi, ctx);
      mgr.setConfig(
        config({
          high: {
            orchestrator: { effort: "high" },
          },
        }),
      );

      await mgr.use("high");
      expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
    });

    it("skips setThinkingLevel for inherit effort", async () => {
      const pi = mockPi();
      const ctx = mockCtx();
      const mgr = new ProfileManager(pi, ctx);
      mgr.setConfig(
        config({
          inherit: {
            orchestrator: { effort: "inherit" },
          },
        }),
      );

      await mgr.use("inherit");
      expect(pi.setThinkingLevel).not.toHaveBeenCalled();
    });

    it("throws for unknown profile", async () => {
      const mgr = new ProfileManager(mockPi(), mockCtx());
      mgr.setConfig(config());

      await expect(mgr.use("nonexistent")).rejects.toThrow(
        "Unknown profile: nonexistent",
      );
    });

    it("rolls back on model failure", async () => {
      const pi = mockPi({
        setModel: vi.fn(async () => false),
      });
      const ctx = mockCtx({ provider: "openai", id: "gpt-4" });
      const mgr = new ProfileManager(pi, ctx);
      mgr.setConfig(
        config({
          fail: {
            orchestrator: {
              model: { provider: "bad", id: "model" },
              effort: "high",
            },
          },
        }),
      );

      await expect(mgr.use("fail")).rejects.toThrow();
      // Baseline should have been restored
      expect(pi.setModel).toHaveBeenCalledTimes(2);
    });
  });

  describe("off", () => {
    it("restores baseline and clears status", async () => {
      const pi = mockPi();
      const ctx = mockCtx({ provider: "openai", id: "gpt-4" });
      const mgr = new ProfileManager(pi, ctx);
      mgr.setConfig(
        config({
          test: {
            orchestrator: {
              model: { provider: "anthropic", id: "claude" },
              effort: "high",
            },
          },
        }),
      );

      await mgr.use("test");
      await mgr.off();

      expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-profiles", undefined);
    });

    it("is no-op when no active profile", async () => {
      const pi = mockPi();
      const ctx = mockCtx();
      const mgr = new ProfileManager(pi, ctx);
      mgr.setConfig(config());

      await mgr.off();
      expect(pi.setModel).not.toHaveBeenCalled();
    });
  });

  describe("next", () => {
    it("cycles through profiles", async () => {
      const pi = mockPi();
      const ctx = mockCtx({ provider: "openai", id: "gpt-4" });
      const mgr = new ProfileManager(pi, ctx);
      mgr.setConfig(
        config({
          a: { orchestrator: { effort: "low" } },
          b: { orchestrator: { effort: "high" } },
        }),
      );

      const first = await mgr.next();
      expect(first.profile).toBe("a");

      const second = await mgr.next();
      expect(second.profile).toBe("b");

      const third = await mgr.next();
      expect(third.profile).toBe("a");
    });

    it("throws when no profiles configured", async () => {
      const mgr = new ProfileManager(mockPi(), mockCtx());
      mgr.setConfig(config());

      await expect(mgr.next()).rejects.toThrow("No profiles configured");
    });
  });
});
