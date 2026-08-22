import { describe, expect, it } from "vitest";
import {
  emptyConfig,
  migrateV1,
  normalizeAgent,
  resolveDefaultRoute,
  resolveRoute,
  supportedShortcut,
  validateConfig,
} from "./config.js";
import { CONFIG_VERSION, DEFAULT_SHORTCUT } from "./constants.js";

describe("normalizeAgent", () => {
  it("trims and lowercases", () => {
    expect(normalizeAgent("  SDD-Apply  ")).toBe("sdd-apply");
  });

  it("handles empty string", () => {
    expect(normalizeAgent("")).toBe("");
  });
});

describe("supportedShortcut", () => {
  it("accepts valid chords", () => {
    expect(supportedShortcut("ctrl+tab")).toBe(true);
    expect(supportedShortcut("ctrl+alt+p")).toBe(true);
    expect(supportedShortcut("alt+shift+f12")).toBe(true);
    expect(supportedShortcut("meta+ctrl+a")).toBe(true);
  });

  it("rejects invalid chords", () => {
    expect(supportedShortcut("ctrl+")).toBe(false);
    expect(supportedShortcut("tab")).toBe(false);
    expect(supportedShortcut("ctrl+a+b")).toBe(false); // trailing extra modifier
    expect(supportedShortcut("")).toBe(false);
  });
});

describe("emptyConfig", () => {
  it("returns version 1 with empty profiles", () => {
    const config = emptyConfig();
    expect(config.version).toBe(CONFIG_VERSION);
    expect(config.profiles).toEqual({});
  });
});

describe("validateConfig", () => {
  it("accepts valid config", () => {
    const result = validateConfig({
      version: 1,
      profiles: {
        test: {
          order: 0,
          orchestrator: {
            model: { provider: "openai", id: "gpt-4" },
            effort: "high",
          },
        },
      },
    });
    expect(result.config).toBeDefined();
    expect(result.error).toBeUndefined();
    expect(result.config!.profiles.test.orchestrator?.model).toEqual({
      provider: "openai",
      id: "gpt-4",
    });
  });

  it("rejects missing version", () => {
    const result = validateConfig({ profiles: {} });
    expect(result.error).toBeDefined();
  });

  it("rejects invalid order", () => {
    const result = validateConfig({
      version: 1,
      profiles: { test: { order: "not-a-number" } },
    });
    expect(result.error).toBeDefined();
  });

  it("rejects invalid shortcut", () => {
    const result = validateConfig({
      version: 1,
      shortcut: 123,
      profiles: {},
    });
    expect(result.error).toBeDefined();
  });

  it("remaps legacy shortcut", () => {
    const result = validateConfig({
      version: 1,
      shortcut: "ctrl+alt+p",
      profiles: {},
    });
    expect(result.config!.shortcut).toBe(DEFAULT_SHORTCUT);
  });

  it("rejects invalid defaultProfile", () => {
    const result = validateConfig({
      version: 1,
      defaultProfile: "nonexistent",
      profiles: { test: { order: 0 } },
    });
    expect(result.error).toBeDefined();
  });

  it("accepts valid defaultProfile", () => {
    const result = validateConfig({
      version: 1,
      defaultProfile: "test",
      profiles: { test: { order: 0 } },
    });
    expect(result.config!.defaultProfile).toBe("test");
  });

  it("accepts valid cycle", () => {
    const result = validateConfig({
      version: 1,
      cycle: ["a", "b"],
      profiles: {
        a: { order: 0 },
        b: { order: 1 },
      },
    });
    expect(result.config!.cycle).toEqual(["a", "b"]);
  });

  it("rejects invalid cycle", () => {
    const result = validateConfig({
      version: 1,
      cycle: ["a", "nonexistent"],
      profiles: { a: { order: 0 } },
    });
    expect(result.error).toBeDefined();
  });
});

describe("migrateV1", () => {
  it("migrates format A (top-level keys)", () => {
    const old = {
      "my-profile": { model: "openai/gpt-4", thinking: "high" },
    };
    const config = migrateV1(old);
    expect(config.version).toBe(CONFIG_VERSION);
    expect(config.profiles["my-profile"]).toBeDefined();
    expect(config.profiles["my-profile"].orchestrator?.model).toEqual({
      provider: "openai",
      id: "gpt-4",
    });
    expect(config.profiles["my-profile"].orchestrator?.effort).toBe("high");
  });

  it("migrates format B (profiles object)", () => {
    const old = {
      profiles: {
        "my-profile": { model: "anthropic/claude", thinking: "low" },
      },
    };
    const config = migrateV1(old);
    expect(config.version).toBe(CONFIG_VERSION);
    expect(config.profiles["my-profile"].orchestrator?.model).toEqual({
      provider: "anthropic",
      id: "claude",
    });
  });

  it("returns empty config if already versioned", () => {
    const config = migrateV1({ version: 1, profiles: {} });
    expect(config.profiles).toEqual({});
  });

  it("returns empty config for non-object input", () => {
    expect(migrateV1(null).profiles).toEqual({});
    expect(migrateV1("string").profiles).toEqual({});
  });

  it("sets default shortcut", () => {
    const config = migrateV1({ p: { model: "a/b", thinking: "low" } });
    expect(config.shortcut).toBe(DEFAULT_SHORTCUT);
  });
});

describe("resolveDefaultRoute", () => {
  it("omits null model", () => {
    const route = resolveDefaultRoute({ model: null, effort: "high" });
    expect(route.model).toBeUndefined();
    expect(route.effort).toBe("high");
  });

  it("omits inherit effort", () => {
    const route = resolveDefaultRoute({
      model: { provider: "a", id: "b" },
      effort: "inherit",
    });
    expect(route.model).toEqual({ provider: "a", id: "b" });
    expect(route.effort).toBeUndefined();
  });

  it("returns empty route for undefined input", () => {
    expect(resolveDefaultRoute(undefined)).toEqual({});
  });
});

describe("resolveRoute", () => {
  it("uses orchestrator as fallback", () => {
    const profile = {
      order: 0,
      orchestrator: {
        model: { provider: "openai", id: "gpt-4" },
        effort: "high" as const,
      },
    };
    const route = resolveRoute(profile, "sdd-apply");
    expect(route.model).toEqual({ provider: "openai", id: "gpt-4" });
    expect(route.effort).toBe("high");
  });

  it("agent override suppresses model", () => {
    const profile = {
      order: 0,
      orchestrator: {
        model: { provider: "openai", id: "gpt-4" },
        effort: "high" as const,
      },
      agents: {
        "sdd-apply": { model: null },
      },
    };
    const route = resolveRoute(profile, "sdd-apply");
    expect(route.model).toBeUndefined();
    expect(route.effort).toBe("high");
  });

  it("agent override suppresses effort via inherit", () => {
    const profile = {
      order: 0,
      orchestrator: {
        model: { provider: "openai", id: "gpt-4" },
        effort: "high" as const,
      },
      agents: {
        "sdd-apply": { effort: "inherit" as const },
      },
    };
    const route = resolveRoute(profile, "sdd-apply");
    expect(route.model).toEqual({ provider: "openai", id: "gpt-4" });
    expect(route.effort).toBeUndefined();
  });
});
