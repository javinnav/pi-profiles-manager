import {
  CONFIG_VERSION,
  DEFAULT_SHORTCUT,
  LEGACY_SHORTCUT,
} from "./constants.js";
import type {
  Config,
  ModelRef,
  PersistedRoute,
  Profile,
  Route,
  RuntimeEffort,
  ThinkingLevel,
} from "./types.js";

const EFFORTS = new Set<ThinkingLevel>([
  "inherit",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const SHORTCUT_REGEX =
  /^(?:(?:ctrl|alt|shift|meta)\+)+(?:[a-z0-9]|tab|f(?:[1-9]|1[0-2]))$/i;

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const has = (value: Record<string, unknown>, key: string) =>
  Object.hasOwn(value, key);

export const normalizeAgent = (name: string) => name.trim().toLowerCase();

export function supportedShortcut(key: string): boolean {
  return SHORTCUT_REGEX.test(key);
}

function validatePersistedRoute(raw: unknown): PersistedRoute | undefined {
  if (!object(raw)) return undefined;

  const result: PersistedRoute = {};

  if (has(raw, "model")) {
    if (raw.model === null) {
      result.model = null;
    } else if (
      object(raw.model) &&
      typeof raw.model.provider === "string" &&
      raw.model.provider.trim() &&
      typeof raw.model.id === "string" &&
      raw.model.id.trim()
    ) {
      result.model = {
        provider: (raw.model.provider as string).trim(),
        id: (raw.model.id as string).trim(),
      } satisfies ModelRef;
    } else {
      return undefined;
    }
  }

  if (has(raw, "effort")) {
    if (
      typeof raw.effort !== "string" ||
      !EFFORTS.has(raw.effort as ThinkingLevel)
    ) {
      return undefined;
    }
    result.effort = raw.effort as ThinkingLevel;
  }

  return Object.keys(result).length ? result : undefined;
}

export function validateConfig(raw: unknown): {
  config?: Config;
  error?: string;
} {
  if (!object(raw) || raw.version !== CONFIG_VERSION || !object(raw.profiles)) {
    return { error: "expected version 1 and profiles object" };
  }

  const profiles: Record<string, Profile> = {};
  for (const [name, rawProfile] of Object.entries(raw.profiles)) {
    if (
      !name.trim() ||
      !object(rawProfile) ||
      !Number.isInteger(rawProfile.order)
    ) {
      return { error: `invalid profile ${name}` };
    }

    const agents: Record<string, PersistedRoute> = {};
    if (rawProfile.agents !== undefined) {
      if (!object(rawProfile.agents)) {
        return { error: `invalid agents in ${name}` };
      }
      for (const [agent, rawRoute] of Object.entries(rawProfile.agents)) {
        const parsed = validatePersistedRoute(rawRoute);
        const normalized = normalizeAgent(agent);
        if (!normalized || !parsed || agents[normalized]) {
          return { error: `invalid agent override ${agent}` };
        }
        agents[normalized] = parsed;
      }
    }

    const orchestrator =
      rawProfile.orchestrator === undefined
        ? undefined
        : validatePersistedRoute(rawProfile.orchestrator);
    if (rawProfile.orchestrator !== undefined && !orchestrator) {
      return { error: `invalid orchestrator in ${name}` };
    }

    profiles[name] = {
      order: rawProfile.order as number,
      ...(orchestrator ? { orchestrator } : {}),
      ...(Object.keys(agents).length ? { agents } : {}),
    };
  }

  const defaultProfile =
    raw.defaultProfile === undefined
      ? undefined
      : typeof raw.defaultProfile === "string" && raw.defaultProfile in profiles
        ? raw.defaultProfile
        : undefined;
  if (raw.defaultProfile !== undefined && !defaultProfile) {
    return { error: "invalid defaultProfile reference" };
  }

  let cycle: string[] | undefined;
  if (raw.cycle !== undefined) {
    if (
      !Array.isArray(raw.cycle) ||
      !raw.cycle.every(
        (name: unknown) => typeof name === "string" && name in profiles,
      ) ||
      new Set(raw.cycle).size !== raw.cycle.length
    ) {
      return { error: "invalid cycle reference" };
    }
    cycle = raw.cycle;
  }

  if (
    raw.shortcut !== undefined &&
    (typeof raw.shortcut !== "string" || !raw.shortcut.trim())
  ) {
    return { error: "invalid shortcut" };
  }

  return {
    config: {
      version: CONFIG_VERSION,
      ...(defaultProfile ? { defaultProfile } : {}),
      ...(cycle ? { cycle } : {}),
      shortcut:
        raw.shortcut === LEGACY_SHORTCUT
          ? DEFAULT_SHORTCUT
          : ((raw.shortcut as string | undefined) ?? DEFAULT_SHORTCUT),
      profiles,
    },
  };
}

export function emptyConfig(): Config {
  return { version: CONFIG_VERSION, profiles: {} };
}

/** Removes config-only suppression sentinels before a route enters an event or snapshot. */
export function resolveDefaultRoute(route: PersistedRoute | undefined): Route {
  const result: Route = {};
  if (route?.model) result.model = route.model;
  if (route?.effort && route.effort !== "inherit") {
    result.effort = route.effort as RuntimeEffort;
  }
  return result;
}

/** Resolves persisted defaults and overrides to an event-safe route. */
export function resolveRoute(profile: Profile, agent: string): Route {
  const fallback = profile.orchestrator;
  const override = profile.agents?.[normalizeAgent(agent)];
  const result = resolveDefaultRoute(fallback);

  if (override && has(override, "model")) {
    if (override.model) result.model = override.model;
    else delete result.model;
  }
  if (override && has(override, "effort")) {
    if (override.effort && override.effort !== "inherit") {
      result.effort = override.effort as RuntimeEffort;
    } else {
      delete result.effort;
    }
  }

  return result;
}

/**
 * Migrate v1 (unversioned) config to v2.
 * Supports two legacy formats:
 *   A: { "profile-name": { model: "provider/id", thinking: "low" } }
 *   B: { profiles: { "profile-name": { model: "...", thinking: "..." } } }
 */
export function migrateV1(data: unknown): Config {
  if (!object(data)) return emptyConfig();

  // Already versioned — no migration needed
  if (has(data, "version")) return emptyConfig();

  const entries: [string, { model: string; thinking: string }][] = [];

  if (object(data.profiles) && !Array.isArray(data.profiles)) {
    // Format B: { profiles: { ... } }
    for (const [name, val] of Object.entries(data.profiles)) {
      if (object(val) && typeof val.model === "string") {
        entries.push([
          name,
          { model: val.model, thinking: String(val.thinking || "low") },
        ]);
      }
    }
  } else {
    // Format A: top-level profile keys
    for (const [name, val] of Object.entries(data)) {
      if (object(val) && typeof val.model === "string" && name !== "version") {
        entries.push([
          name,
          { model: val.model, thinking: String(val.thinking || "low") },
        ]);
      }
    }
  }

  const profiles: Record<string, Profile> = {};
  for (let i = 0; i < entries.length; i++) {
    const [name, old] = entries[i];
    const slash = old.model.indexOf("/");
    const provider = slash === -1 ? "" : old.model.slice(0, slash);
    const id = slash === -1 ? old.model : old.model.slice(slash + 1);

    profiles[name] = {
      order: i,
      orchestrator: {
        model: provider || id ? { provider, id } : undefined,
        effort: (old.thinking as ThinkingLevel) || "low",
      },
    };
  }

  return {
    version: CONFIG_VERSION,
    shortcut: DEFAULT_SHORTCUT,
    profiles,
  };
}
