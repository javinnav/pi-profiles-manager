import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ProfileManager } from "./profile-manager.js";
import type { ContextLike, PiLike } from "./types.js";

type SaveFn = (ctx: ExtensionCommandContext, name: string) => Promise<void>;
type LoadFn = (ctx: ExtensionCommandContext) => Promise<void>;
type OpenTuiFn = (ctx: ContextLike) => Promise<void>;
type SyncFn = (ctx: ExtensionCommandContext) => Promise<void>;

const COMMAND_ACTIONS = [
	"list",
	"status",
	"sync",
	"use",
	"save",
	"next",
	"off",
];

export function parseCommand(input: string): { verb: string; name: string } {
	const [verb = "", ...rest] = input.trim().split(/\s+/);
	return { verb: verb.toLowerCase(), name: rest.join(" ") };
}

export function registerCommands(
	pi: PiLike,
	manager: ProfileManager,
	_save: SaveFn,
	_load: LoadFn,
	openTui: OpenTuiFn = async () => {},
	sync: SyncFn = async () => {},
) {
	pi.registerCommand("profiles:sync", {
		description: "Sync PiProfiles with managed agents folder",
		async handler(_args: string, ctx: ExtensionCommandContext) {
			try {
				await sync(ctx);
			} catch (error: unknown) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});

	pi.registerCommand("profiles", {
		description: "Manage SDD model profiles",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trimStart();
			const [action = "", ...nameParts] = trimmed.split(/\s+/);
			const verb = action.toLowerCase();

			if (!/\s/.test(trimmed)) {
				return COMMAND_ACTIONS.filter((value) => value.startsWith(verb)).map(
					(value) => ({ value, label: value }),
				);
			}

			if (verb !== "use" && verb !== "save") return [];

			const namePrefix = nameParts.join(" ");
			return manager
				.names()
				.filter((name) => name.startsWith(namePrefix))
				.map((value) => ({ value, label: value }));
		},
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
				if (verb === "sync") {
					await sync(ctx);
					return;
				}
				if (verb === "use") {
					if (!name) {
						return ctx.ui.notify("Usage: /profiles use <name>", "error");
					}
					await manager.use(name);
					return;
				}
				if (verb === "save") {
					if (!name) {
						return ctx.ui.notify("Usage: /profiles save <name>", "error");
					}
					await _save(ctx, name);
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
				return openTui(ctx as ContextLike);
			} catch (error: unknown) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});
}
