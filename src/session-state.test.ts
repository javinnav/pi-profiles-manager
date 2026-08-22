import { describe, expect, it, vi } from "vitest";
import { ACTIVE_ENTRY_TYPE } from "./constants.js";
import { SessionState } from "./session-state.js";
import type { ActiveSnapshot, ContextLike, PiLike } from "./types.js";

function mockPi(overrides?: Partial<PiLike>): PiLike {
  return {
    appendEntry: vi.fn(),
    getThinkingLevel: () => "medium",
    registerCommand: vi.fn() as any,
    registerShortcut: vi.fn() as any,
    setModel: vi.fn() as any,
    setThinkingLevel: vi.fn(),
    on: vi.fn() as any,
    ...overrides,
  };
}

function mockCtx(
  sessionId: string | undefined = "session-1",
  branch: unknown[] = [],
): ContextLike {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branch,
    },
    ui: { setStatus: vi.fn(), notify: vi.fn() },
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn() },
    cwd: "/tmp",
    isProjectTrusted: () => false,
    model: undefined,
  } as unknown as ContextLike;
}

function snapshot(overrides?: Partial<ActiveSnapshot>): ActiveSnapshot {
  return {
    profile: "test-profile",
    route: { model: { provider: "openai", id: "gpt-4" }, effort: "high" },
    baseline: { effort: "medium" },
    activatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("SessionState", () => {
  describe("get", () => {
    it("returns undefined for unknown session", () => {
      const state = new SessionState();
      expect(state.get("unknown")).toBeUndefined();
    });

    it("returns snapshot after activate", () => {
      const state = new SessionState();
      const pi = mockPi();
      const ctx = mockCtx();
      const snap = snapshot();

      state.activate(pi, ctx, snap);
      expect(state.get("session-1")).toBe(snap);
    });
  });

  describe("shouldDefault", () => {
    it("returns true when no active and no off", () => {
      const state = new SessionState();
      expect(state.shouldDefault("session-1")).toBe(true);
    });

    it("returns false when active", () => {
      const state = new SessionState();
      state.activate(mockPi(), mockCtx(), snapshot());
      expect(state.shouldDefault("session-1")).toBe(false);
    });

    it("returns false when off", () => {
      const state = new SessionState();
      state.deactivate(mockPi(), mockCtx());
      expect(state.shouldDefault("session-1")).toBe(false);
    });
  });

  describe("activate", () => {
    it("returns false when no session id", () => {
      const state = new SessionState();
      const ctx = mockCtx();
      (ctx.sessionManager.getSessionId as any) = () => undefined;
      const result = state.activate(mockPi(), ctx, snapshot());
      expect(result).toBe(false);
    });

    it("appends entry via pi.appendEntry", () => {
      const state = new SessionState();
      const pi = mockPi();
      const ctx = mockCtx();
      const snap = snapshot();

      state.activate(pi, ctx, snap);
      expect(pi.appendEntry).toHaveBeenCalledWith(ACTIVE_ENTRY_TYPE, snap);
    });

    it("removes from off set", () => {
      const state = new SessionState();
      const pi = mockPi();
      const ctx = mockCtx();

      state.deactivate(pi, ctx);
      expect(state.shouldDefault("session-1")).toBe(false);

      state.activate(pi, ctx, snapshot());
      expect(state.shouldDefault("session-1")).toBe(false);
      expect(state.get("session-1")).toBeDefined();
    });
  });

  describe("deactivate", () => {
    it("returns false when no session id", () => {
      const state = new SessionState();
      const ctx = mockCtx();
      (ctx.sessionManager.getSessionId as any) = () => undefined;
      const result = state.deactivate(mockPi(), ctx);
      expect(result).toBe(false);
    });

    it("appends off entry", () => {
      const state = new SessionState();
      const pi = mockPi();
      const ctx = mockCtx();

      state.deactivate(pi, ctx);
      expect(pi.appendEntry).toHaveBeenCalledWith(ACTIVE_ENTRY_TYPE, {
        off: true,
      });
    });

    it("clears active and adds to off", () => {
      const state = new SessionState();
      const pi = mockPi();
      const ctx = mockCtx();

      state.activate(pi, ctx, snapshot());
      expect(state.get("session-1")).toBeDefined();

      state.deactivate(pi, ctx);
      expect(state.get("session-1")).toBeUndefined();
      expect(state.shouldDefault("session-1")).toBe(false);
    });
  });

  describe("restore", () => {
    it("returns undefined for no session id", () => {
      const state = new SessionState();
      expect(state.restore(mockCtx(undefined))).toBeUndefined();
    });

    it("restores from branch with active snapshot", () => {
      const state = new SessionState();
      const snap = snapshot();
      const branch = [
        { type: "custom", customType: "other", data: {} },
        { type: "custom", customType: ACTIVE_ENTRY_TYPE, data: snap },
      ];
      const ctx = mockCtx("session-1", branch);

      const result = state.restore(ctx);
      expect(result).toEqual(snap);
      expect(state.get("session-1")).toEqual(snap);
    });

    it("returns undefined and adds to off for {off: true}", () => {
      const state = new SessionState();
      const branch = [
        { type: "custom", customType: ACTIVE_ENTRY_TYPE, data: { off: true } },
      ];
      const ctx = mockCtx("session-1", branch);

      const result = state.restore(ctx);
      expect(result).toBeUndefined();
      expect(state.shouldDefault("session-1")).toBe(false);
    });

    it("skips corrupt entries", () => {
      const state = new SessionState();
      const snap = snapshot();
      const branch = [
        { type: "custom", customType: ACTIVE_ENTRY_TYPE, data: "corrupt" },
        { type: "custom", customType: ACTIVE_ENTRY_TYPE, data: snap },
      ];
      const ctx = mockCtx("session-1", branch);

      const result = state.restore(ctx);
      expect(result).toEqual(snap);
    });

    it("uses last entry in reverse order", () => {
      const state = new SessionState();
      const snap1 = snapshot({ profile: "first" });
      const snap2 = snapshot({ profile: "second" });
      const branch = [
        { type: "custom", customType: ACTIVE_ENTRY_TYPE, data: snap1 },
        { type: "custom", customType: ACTIVE_ENTRY_TYPE, data: snap2 },
      ];
      const ctx = mockCtx("session-1", branch);

      const result = state.restore(ctx);
      expect(result?.profile).toBe("second");
    });
  });

  describe("clear", () => {
    it("clears specific session", () => {
      const state = new SessionState();
      const pi = mockPi();
      const ctx = mockCtx();

      state.activate(pi, ctx, snapshot());
      state.clear("session-1");
      expect(state.get("session-1")).toBeUndefined();
    });

    it("clears all sessions", () => {
      const state = new SessionState();
      const pi = mockPi();

      state.activate(pi, mockCtx("s1"), snapshot({ profile: "p1" }));
      state.activate(pi, mockCtx("s2"), snapshot({ profile: "p2" }));
      state.clear();

      expect(state.get("s1")).toBeUndefined();
      expect(state.get("s2")).toBeUndefined();
    });
  });

  describe("graceful degradation", () => {
    it("continues when appendEntry throws", () => {
      const state = new SessionState();
      const pi = mockPi({
        appendEntry: vi.fn(() => {
          throw new Error("unavailable");
        }),
      });
      const ctx = mockCtx();
      const snap = snapshot();

      const result = state.activate(pi, ctx, snap);
      expect(result).toBe(true);
      expect(state.get("session-1")).toBe(snap);
    });

    it("returns undefined when getBranch throws", () => {
      const state = new SessionState();
      const ctx = {
        sessionManager: {
          getSessionId: () => "session-1",
          getBranch: () => {
            throw new Error("unavailable");
          },
        },
      } as unknown as ContextLike;

      const result = state.restore(ctx);
      expect(result).toBeUndefined();
    });
  });
});
