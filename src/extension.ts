import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.js";
import {
  emptyConfig,
  migrateV1,
  supportedShortcut,
  validateConfig,
} from "./config.js";
import { DEFAULT_SHORTCUT, STATUS_KEY } from "./constants.js";
import { ProfileManager } from "./profile-manager.js";
import type { Config, ContextLike, PiLike } from "./types.js";

/** Synchronous config read at load time for shortcut registration. */
function readGlobalConfigSync(path: string): Config {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));

    // Migration: if no version field, migrate from v1
    if (raw && typeof raw === "object" && !("version" in raw)) {
      return migrateV1(raw);
    }

    const result = validateConfig(raw);
    return result.config ?? emptyConfig();
  } catch {
    return emptyConfig();
  }
}

export default function extension(pi: PiLike) {
  const globalPath = join(getAgentDir(), "pi-profiles", "config.json");
  const manager = new ProfileManager(pi);

  // Synchronous read for shortcut registration
  const globalConfig = readGlobalConfigSync(globalPath);
  manager.setConfig(globalConfig);

  // --- Shortcut Registration ---
  const shortcut = globalConfig.shortcut ?? DEFAULT_SHORTCUT;
  let shortcutDiagnostic: string | undefined;

  const shortcutOptions = {
    description: "Cycle agent profile",
    async handler(ctx: ContextLike) {
      manager.setContext(ctx);
      try {
        await manager.next();
      } catch (error: unknown) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  };

  if (supportedShortcut(shortcut)) {
    try {
      pi.registerShortcut(
        shortcut as Parameters<PiLike["registerShortcut"]>[0],
        shortcutOptions,
      );
    } catch {
      try {
        pi.registerShortcut(DEFAULT_SHORTCUT, shortcutOptions);
      } catch {
        shortcutDiagnostic = `Shortcut registration failed; no shortcut registered`;
      }
    }
  } else {
    shortcutDiagnostic = `Shortcut "${shortcut}" is invalid; using ${DEFAULT_SHORTCUT}`;
    try {
      pi.registerShortcut(DEFAULT_SHORTCUT, shortcutOptions);
    } catch {
      shortcutDiagnostic = `Shortcut registration failed; no shortcut registered`;
    }
  }

  // --- Lifecycle Hooks ---
  async function load(ctx: ContextLike) {
    manager.setContext(ctx);

    // Re-read config (may have changed)
    const freshConfig = readGlobalConfigSync(globalPath);
    manager.setConfig(freshConfig);

    // Report deferred diagnostic
    if (shortcutDiagnostic) {
      ctx.ui.notify(shortcutDiagnostic, "warning");
      shortcutDiagnostic = undefined;
    }

    // Restore session state
    const restored = manager.state.restore(ctx);
    if (restored) {
      try {
        await manager.use(restored.profile);
      } catch {
        // Profile may be invalid; clear and continue
        manager.state.clear(ctx.sessionManager.getSessionId());
      }
    } else if (
      freshConfig.defaultProfile &&
      manager.state.shouldDefault(ctx.sessionManager.getSessionId())
    ) {
      try {
        await manager.use(freshConfig.defaultProfile);
      } catch {
        // Default profile invalid; continue without
      }
    }
  }

  pi.on("session_start", async (_event: unknown, ctx: unknown) => {
    try {
      await load(ctx as ContextLike);
    } catch (error: unknown) {
      (ctx as ContextLike).ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  });

  pi.on("session_shutdown", async (_event: unknown, ctx: unknown) => {
    const context = ctx as ContextLike;
    const sessionId = context.sessionManager.getSessionId();
    manager.state.clear(sessionId);
    context.ui.setStatus(STATUS_KEY, undefined);
  });

  // --- Commands ---
  registerCommands(
    pi,
    manager,
    async () => {},
    async () => {},
  );
}
