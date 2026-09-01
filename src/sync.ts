import { readdir } from "node:fs/promises";
import { normalizeAgent } from "./config.js";
import type { Config, PersistedRoute } from "./types.js";

export type SyncResult = {
  config: Config;
  added: number;
  removed: number;
};

export async function discoverManagedAgentNames(
  agentsDir: string,
): Promise<string[]> {
  try {
    const entries = await readdir(agentsDir);
    return [...new Set(
      entries
        .filter((entry) => entry.endsWith(".md"))
        .map((entry) => normalizeAgent(entry.slice(0, -3)))
        .filter(Boolean),
    )].sort();
  } catch {
    return [];
  }
}

export function reconcileProfileAgents(
  config: Config,
  discoveredAgents: string[],
): SyncResult {
  const discovered = new Set(
    discoveredAgents.map(normalizeAgent).filter(Boolean),
  );
  let added = 0;
  let removed = 0;

  const profiles = Object.fromEntries(
    Object.entries(config.profiles).map(([name, profile]) => {
      const existing = profile.agents ?? {};
      const agents: Record<string, PersistedRoute> = {};

      for (const agent of discovered) {
        if (existing[agent]) {
          agents[agent] = existing[agent];
        } else {
          agents[agent] = profile.orchestrator?.model
            ? { model: { ...profile.orchestrator.model } }
            : { model: null };
          added++;
        }
      }
      for (const agent of Object.keys(existing)) {
        if (!discovered.has(agent)) removed++;
      }

      const { agents: _existingAgents, ...profileWithoutAgents } = profile;
      return [
        name,
        {
          ...profileWithoutAgents,
          ...(Object.keys(agents).length ? { agents } : {}),
        },
      ];
    }),
  ) as Config["profiles"];

  return { config: { ...config, profiles }, added, removed };
}
