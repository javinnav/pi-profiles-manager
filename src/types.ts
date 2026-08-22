import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Pi runtime thinking levels plus the inherit sentinel. */
export type RuntimeEffort = Exclude<
  ReturnType<ExtensionAPI["getThinkingLevel"]>,
  "inherit"
>;
export type ThinkingLevel = RuntimeEffort | "inherit";

export type ModelRef = { provider: string; id: string };

/** Event-safe route — never contains persistence sentinels. */
export type Route = { model?: ModelRef; effort?: RuntimeEffort };

/** Persisted route — supports explicit suppression via null/inherit. */
export type PersistedRoute = {
  model?: ModelRef | null;
  effort?: ThinkingLevel;
};

export type Profile = {
  order: number;
  orchestrator?: PersistedRoute;
  agents?: Record<string, PersistedRoute>;
};

export type Config = {
  version: 1;
  defaultProfile?: string;
  cycle?: string[];
  shortcut?: string;
  profiles: Record<string, Profile>;
};

export type ActiveSnapshot = {
  profile: string;
  route: Route;
  baseline: Route;
  activatedAt: string;
};

/** Minimal ExtensionAPI subset this extension needs. */
export type PiLike = Pick<
  ExtensionAPI,
  | "appendEntry"
  | "getThinkingLevel"
  | "registerCommand"
  | "registerShortcut"
  | "setModel"
  | "setThinkingLevel"
  | "on"
> & {
  events?: {
    on(name: string, cb: (value: unknown) => void): void | (() => void);
    off?(name: string, cb: (value: unknown) => void): void;
  };
};

export type ContextLike = ExtensionContext;
