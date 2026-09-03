import { describe, expect, it, vi } from "vitest";
import { ProfileManager } from "./profile-manager.js";
import type { Config, ContextLike, PiLike, Profile } from "./types.js";

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

function config(profiles: Record<string, Partial<Profile>> = {}): Config {
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

type AgentSyncRequest = {
  routes: Record<string, unknown>;
  ownedAgentNames: ReadonlySet<string>;
};

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

    it("sends selected routes and durable ownership on first activation", async () => {
      const pi = mockPi();
      const ctx = mockCtx();
      const applyAgentRoutes = vi.fn(async () => {});
      const mgr = new ProfileManager(pi, ctx, applyAgentRoutes);
      mgr.setConfig(
        config({
          selected: { agents: { reviewer: { effort: "low" } } },
          other: {
            agents: {
              Writer: { model: { provider: "openai", id: "gpt-4" } },
            },
          },
        }),
      );

      await mgr.use("selected");

      expect(applyAgentRoutes).toHaveBeenCalledWith({
        routes: { reviewer: { effort: "low" } },
        ownedAgentNames: new Set(["reviewer", "writer"]),
      });
      expect(applyAgentRoutes).toHaveBeenCalledTimes(1);
    });

    it("keeps durable ownership when the active snapshot is incomplete", async () => {
      const pi = mockPi();
      const ctx = mockCtx();
      const applyAgentRoutes = vi.fn(async () => {});
      const mgr = new ProfileManager(pi, ctx, applyAgentRoutes);
      mgr.setConfig(
        config({
          first: { agents: { " Reviewer ": { effort: "low" } } },
          second: { agents: { WRITER: { effort: "high" } } },
          empty: { agents: {} },
        }),
      );

      await mgr.use("first");
      const requests = applyAgentRoutes.mock.calls as unknown as [
        [AgentSyncRequest],
        [AgentSyncRequest],
      ];
      const firstRequest = requests[0][0];
      await mgr.use("empty");
      const secondRequest = requests[1][0];

      expect(firstRequest).toEqual({
        routes: { " Reviewer ": { effort: "low" } },
        ownedAgentNames: new Set(["reviewer", "writer"]),
      });
      expect(secondRequest).toEqual({
        routes: {},
        ownedAgentNames: new Set(["reviewer", "writer"]),
      });
      expect(secondRequest.ownedAgentNames).not.toBe(
        firstRequest.ownedAgentNames,
      );
      expect(applyAgentRoutes.mock.calls.map((call) => call.length)).toEqual([
        1,
        1,
      ]);
    });

    it("applies the orchestrator before routes and commits status last", async () => {
      const events: string[] = [];
      const pi = mockPi({
        setThinkingLevel: vi.fn(() => events.push("orchestrator")),
      });
      const ctx = mockCtx();
      ctx.ui.setStatus = vi.fn(() => events.push("status"));
      const applyAgentRoutes = vi.fn(async () => {
        events.push("agents");
      });
      const mgr = new ProfileManager(pi, ctx, applyAgentRoutes);
      mgr.setConfig(config({ selected: { orchestrator: { effort: "high" } } }));

      await mgr.use("selected");

      expect(events).toEqual(["orchestrator", "agents", "status"]);
    });

        it("does not fall back to the orchestrator route for unmanaged agents", async () => {
          const mgr = new ProfileManager(mockPi(), mockCtx());
          mgr.setConfig(
            config({
              selected: {
                orchestrator: {
                  model: { provider: "anthropic", id: "claude" },
                },
                agents: {
                  reviewer: { effort: "low" },
                },
              },
            }),
          );

          await mgr.use("selected");

          expect(mgr.resolveAgentRoute("reviewer", "session-1")).toEqual({
            effort: "low",
          });
          expect(mgr.resolveAgentRoute("writer", "session-1")).toBeUndefined();
        });

        it("throws for unknown profile", async () => {
          const mgr = new ProfileManager(mockPi(), mockCtx());
          mgr.setConfig(config());

          await expect(mgr.use("nonexistent")).rejects.toThrow(
            "Unknown profile: nonexistent",
          );
        });

    it("rolls back on model failure before synchronizing agents", async () => {
      const pi = mockPi({
        setModel: vi.fn(async () => false),
      });
      const ctx = mockCtx({ provider: "openai", id: "gpt-4" });
      const applyAgentRoutes = vi.fn(async () => {});
      const mgr = new ProfileManager(pi, ctx, applyAgentRoutes);
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
      expect(applyAgentRoutes).not.toHaveBeenCalled();
      expect(pi.setModel).toHaveBeenCalledTimes(2);
      expect(mgr.state.get("session-1")).toBeUndefined();
      expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    });

    it("rethrows concrete thinking-level failures before synchronizing agents", async () => {
      const error = new Error("thinking level unavailable");
      const pi = mockPi({
        setThinkingLevel: vi.fn(() => {
          throw error;
        }),
      });
      const ctx = mockCtx();
      const applyAgentRoutes = vi.fn(async () => {});
      const mgr = new ProfileManager(pi, ctx, applyAgentRoutes);
      mgr.setConfig(config({ fail: { orchestrator: { effort: "high" } } }));

      await expect(mgr.use("fail")).rejects.toBe(error);
      expect(applyAgentRoutes).not.toHaveBeenCalled();
      expect(pi.setThinkingLevel).toHaveBeenCalledTimes(2);
      expect(mgr.state.get("session-1")).toBeUndefined();
      expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    });

    it("rolls back and leaves state uncommitted when agent synchronization fails", async () => {
      const error = new Error("agent synchronization failed");
      const pi = mockPi();
      const ctx = mockCtx();
      const applyAgentRoutes = vi.fn(async () => {
        throw error;
      });
      const mgr = new ProfileManager(pi, ctx, applyAgentRoutes);
      mgr.setConfig(config({ fail: { orchestrator: { effort: "high" } } }));

      await expect(mgr.use("fail")).rejects.toBe(error);
      expect(pi.setThinkingLevel).toHaveBeenNthCalledWith(1, "high");
      expect(pi.setThinkingLevel).toHaveBeenNthCalledWith(2, "medium");
      expect(mgr.state.get("session-1")).toBeUndefined();
      expect(ctx.ui.setStatus).not.toHaveBeenCalled();
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
