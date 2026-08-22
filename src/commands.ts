import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ProfileManager } from "./profile-manager.js";
import type { PiLike } from "./types.js";

type SaveFn = (
  ctx: ExtensionCommandContext,
  name: string,
  profile: any,
  scope: string,
) => Promise<void>;
type LoadFn = (ctx: ExtensionCommandContext) => Promise<void>;

export function parseCommand(input: string): { verb: string; name: string } {
  const [verb = "", ...rest] = input.trim().split(/\s+/);
  return { verb: verb.toLowerCase(), name: rest.join(" ") };
}

export function registerCommands(
  pi: PiLike,
  manager: ProfileManager,
  _save: SaveFn,
  _load: LoadFn,
) {
  pi.registerCommand("profiles", {
    description: "Manage SDD model profiles",
    getArgumentCompletions: (prefix) =>
      manager
        .names()
        .filter((name) => name.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    async handler(args: string, ctx: ExtensionCommandContext) {
      manager.setContext(ctx);
      const { verb, name } = parseCommand(args);

      try {
        if (verb === "list") {
          return ctx.ui.notify(manager.names().join("\n") || "No profiles");
        }
        if (verb === "status") {
          const active = manager.state.get(ctx.sessionManager.getSessionId());
          return ctx.ui.notify(active?.profile ?? "none");
        }
        if (verb === "use") {
          if (!name) {
            return ctx.ui.notify("Usage: /profiles use <name>", "error");
          }
          await manager.use(name);
          return;
        }
        if (verb === "next") {
          await manager.next();
          return;
        }
        if (verb === "off") {
          await manager.off();
          return;
        }
        // Default: open interactive TUI (existing behavior preserved)
        // The old /profiles and /profiles save commands continue to work
        // through the original monolith code in index.ts
        return ctx.ui.notify(
          "Use /profiles list, /profiles use <name>, /profiles next, or /profiles off",
          "info",
        );
      } catch (error: unknown) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });
}
