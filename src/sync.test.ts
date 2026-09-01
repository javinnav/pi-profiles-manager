import { describe, expect, it } from "vitest";
import { reconcileProfileAgents } from "./sync.js";
import type { Config } from "./types.js";

function config(): Config {
  return {
    version: 1,
    defaultProfile: "alpha",
    cycle: ["alpha", "beta"],
    shortcut: "ctrl+tab",
    profiles: {
      alpha: {
        order: 0,
        orchestrator: {
          model: { provider: "anthropic", id: "claude" },
          effort: "high",
        },
        agents: {
          reviewer: { model: { provider: "openai", id: "gpt-4" }, effort: "low" },
          legacy: { effort: "medium" },
        },
      },
      beta: { order: 1, orchestrator: { effort: "low" } },
    },
  };
}

describe("reconcileProfileAgents", () => {
  it("adds discovered agents with each profile's orchestrator model only", () => {
    const result = reconcileProfileAgents(config(), ["reviewer", "writer"]);

    expect(result.config.profiles.alpha.agents).toEqual({
      reviewer: { model: { provider: "openai", id: "gpt-4" }, effort: "low" },
      writer: { model: { provider: "anthropic", id: "claude" } },
    });
    expect(result.config.profiles.beta.agents).toEqual({
      reviewer: { model: null },
      writer: { model: null },
    });
    expect(result.added).toBe(3);
    expect(result.removed).toBe(1);
  });

  it("removes missing routes, making renames remove-old and add-new", () => {
    const result = reconcileProfileAgents(config(), ["replacement"]);

    expect(result.config.profiles.alpha.agents).toEqual({
      replacement: { model: { provider: "anthropic", id: "claude" } },
    });
    expect(result.config.profiles.beta.agents).toEqual({
      replacement: { model: null },
    });
    expect(result.added).toBe(2);
    expect(result.removed).toBe(2);
  });

  it("omits agents when discovery removes every existing agent", () => {
    const result = reconcileProfileAgents(config(), []);

    expect(result.config.profiles.alpha).not.toHaveProperty("agents");
    expect(result.config.profiles.beta).not.toHaveProperty("agents");
    expect(result.added).toBe(0);
    expect(result.removed).toBe(2);
  });

  it("preserves all non-agent config and profile fields", () => {
    const source = config();
    const result = reconcileProfileAgents(source, ["reviewer"]);

    expect(result.config).toMatchObject({
      defaultProfile: "alpha",
      cycle: ["alpha", "beta"],
      shortcut: "ctrl+tab",
      profiles: {
        alpha: {
          order: 0,
          orchestrator: {
            model: { provider: "anthropic", id: "claude" },
            effort: "high",
          },
          agents: {
            reviewer: { model: { provider: "openai", id: "gpt-4" }, effort: "low" },
          },
        },
        beta: { order: 1, orchestrator: { effort: "low" } },
      },
    });
  });
});
