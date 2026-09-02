import { describe, expect, it, vi } from "vitest";
import { parseCommand, registerCommands } from "./commands.js";
import { ProfileManager } from "./profile-manager.js";
import type { Config, ContextLike, PiLike } from "./types.js";

function mockPi(): PiLike {
	return {
		appendEntry: vi.fn(),
		getThinkingLevel: vi.fn(() => "medium" as const),
		registerCommand: vi.fn() as any,
		registerShortcut: vi.fn() as any,
		setModel: vi.fn(async () => true),
		setThinkingLevel: vi.fn(),
		on: vi.fn() as any,
	};
}

function mockCtx(sessionId = "session-1"): ContextLike {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => [],
		},
		ui: { setStatus: vi.fn(), notify: vi.fn() },
		modelRegistry: { find: vi.fn(), getAvailable: vi.fn() },
		model: undefined,
		cwd: "/tmp",
		isProjectTrusted: () => false,
	} as unknown as ContextLike;
}

function configWithProfiles(names: string[]): Config {
	return {
		version: 1,
		profiles: Object.fromEntries(names.map((name, i) => [name, { order: i }])),
	};
}

describe("parseCommand", () => {
	it("parses verb and name", () => {
		expect(parseCommand("use my-profile")).toEqual({
			verb: "use",
			name: "my-profile",
		});
	});

	it("lowercases verb", () => {
		expect(parseCommand("NEXT")).toEqual({ verb: "next", name: "" });
	});

	it("handles empty input", () => {
		expect(parseCommand("")).toEqual({ verb: "", name: "" });
	});

	it("handles single verb", () => {
		expect(parseCommand("list")).toEqual({ verb: "list", name: "" });
	});
});

describe("registerCommands", () => {
	it("registers /profiles command", () => {
		const pi = mockPi();
		const mgr = new ProfileManager(pi, mockCtx());
		mgr.setConfig(configWithProfiles([]));

		registerCommands(pi, mgr, vi.fn() as any, vi.fn() as any);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"profiles",
			expect.any(Object),
		);
	});

	it("registers slash-command aliases for every profile action", () => {
		const pi = mockPi();
		const mgr = new ProfileManager(pi, mockCtx());
		mgr.setConfig(configWithProfiles([]));

		registerCommands(pi, mgr, vi.fn() as any, vi.fn() as any);

		for (const action of [
			"list",
			"status",
			"sync",
			"use",
			"save",
			"next",
			"off",
		]) {
			expect(pi.registerCommand).toHaveBeenCalledWith(
				`profiles:${action}`,
				expect.any(Object),
			);
		}
	});

	it("completes actions first and profile names after use or save", () => {
		const pi = mockPi();
		const mgr = new ProfileManager(pi, mockCtx());
		mgr.setConfig(configWithProfiles(["alpha", "team profile"]));

		registerCommands(pi, mgr, vi.fn() as any, vi.fn() as any);

		const completions = (pi.registerCommand as any).mock.calls.find(
			(c: any[]) => c[0] === "profiles",
		)[1].getArgumentCompletions;
		expect(completions("s")).toEqual([
			{ value: "status", label: "status" },
			{ value: "sync", label: "sync" },
			{ value: "save", label: "save" },
		]);
		expect(completions("use team p")).toEqual([
			{ value: "team profile", label: "team profile" },
		]);
		expect(completions("save alpha")).toEqual([
			{ value: "alpha", label: "alpha" },
		]);
	});

	it("list subcommand notifies profile names", async () => {
		const pi = mockPi();
		const ctx = mockCtx();
		const mgr = new ProfileManager(pi, ctx);
		mgr.setConfig(configWithProfiles(["alpha", "beta"]));

		registerCommands(pi, mgr, vi.fn() as any, vi.fn() as any);

		const handler = (pi.registerCommand as any).mock.calls.find(
			(c: any[]) => c[0] === "profiles",
		)[1].handler;
		await handler("list", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("alpha\nbeta");
	});

	it("status subcommand notifies active profile", async () => {
		const pi = mockPi();
		const ctx = mockCtx();
		const mgr = new ProfileManager(pi, ctx);
		mgr.setConfig(configWithProfiles(["test"]));

		registerCommands(pi, mgr, vi.fn() as any, vi.fn() as any);

		const handler = (pi.registerCommand as any).mock.calls.find(
			(c: any[]) => c[0] === "profiles",
		)[1].handler;
		await handler("status", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("none");
	});

	it("use subcommand activates profile", async () => {
		const pi = mockPi();
		const ctx = mockCtx();
		const mgr = new ProfileManager(pi, ctx);
		mgr.setConfig(configWithProfiles(["test"]));

		registerCommands(pi, mgr, vi.fn() as any, vi.fn() as any);

		const handler = (pi.registerCommand as any).mock.calls.find(
			(c: any[]) => c[0] === "profiles",
		)[1].handler;
		await handler("use test", ctx);

		expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-profiles", "test");
	});

	it("use without name notifies error", async () => {
		const pi = mockPi();
		const ctx = mockCtx();
		const mgr = new ProfileManager(pi, ctx);
		mgr.setConfig(configWithProfiles([]));

		registerCommands(pi, mgr, vi.fn() as any, vi.fn() as any);

		const handler = (pi.registerCommand as any).mock.calls.find(
			(c: any[]) => c[0] === "profiles",
		)[1].handler;
		await handler("use", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Usage: /profiles use <name>",
			"error",
		);
	});

	it("save subcommand delegates a named snapshot without opening the TUI", async () => {
		const pi = mockPi();
		const ctx = mockCtx();
		const mgr = new ProfileManager(pi, ctx);
		const save = vi.fn(async () => {});
		const openTui = vi.fn(async () => {});
		mgr.setConfig(configWithProfiles([]));

		registerCommands(pi, mgr, save as any, vi.fn() as any, openTui);

		const handler = (pi.registerCommand as any).mock.calls.find(
			(c: any[]) => c[0] === "profiles",
		)[1].handler;
		await handler("save snapshot", ctx);

		expect(save).toHaveBeenCalledWith(ctx, "snapshot");
		expect(openTui).not.toHaveBeenCalled();
	});

	it("save without a name notifies usage", async () => {
		const pi = mockPi();
		const ctx = mockCtx();
		const mgr = new ProfileManager(pi, ctx);
		const save = vi.fn(async () => {});
		mgr.setConfig(configWithProfiles([]));

		registerCommands(pi, mgr, save as any, vi.fn() as any);

		const handler = (pi.registerCommand as any).mock.calls.find(
			(c: any[]) => c[0] === "profiles",
		)[1].handler;
		await handler("save", ctx);

		expect(save).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Usage: /profiles save <name>",
			"error",
		);
	});

	it("off subcommand deactivates", async () => {
		const pi = mockPi();
		const ctx = mockCtx();
		const mgr = new ProfileManager(pi, ctx);
		mgr.setConfig(configWithProfiles(["test"]));

		registerCommands(pi, mgr, vi.fn() as any, vi.fn() as any);

		// First activate
		const handler = (pi.registerCommand as any).mock.calls.find(
			(c: any[]) => c[0] === "profiles",
		)[1].handler;
		await handler("use test", ctx);

		// Then deactivate
		await handler("off", ctx);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-profiles", undefined);
	});

	it("next subcommand cycles", async () => {
		const pi = mockPi();
		const ctx = mockCtx();
		const mgr = new ProfileManager(pi, ctx);
		mgr.setConfig(configWithProfiles(["a", "b"]));

		registerCommands(pi, mgr, vi.fn() as any, vi.fn() as any);

		const handler = (pi.registerCommand as any).mock.calls.find(
			(c: any[]) => c[0] === "profiles",
		)[1].handler;
		await handler("next", ctx);

		expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-profiles", "a");
	});

	it("sync subcommand delegates without opening the TUI", async () => {
		const pi = mockPi();
		const ctx = mockCtx();
		const mgr = new ProfileManager(pi, ctx);
		const sync = vi.fn(async () => {});
		const openTui = vi.fn(async () => {});
		mgr.setConfig(configWithProfiles([]));

		registerCommands(pi, mgr, vi.fn() as any, vi.fn() as any, openTui, sync);

		const callArgs = (pi.registerCommand as any).mock.calls.find(
			(c: any[]) => c[0] === "profiles",
		);
		const handler = callArgs[1].handler;
		await handler("sync", ctx);

		expect(sync).toHaveBeenCalledWith(ctx);
		expect(openTui).not.toHaveBeenCalled();
	});

	it("profiles action aliases delegate through the existing action handling", async () => {
		const pi = mockPi();
		const ctx = mockCtx();
		const mgr = new ProfileManager(pi, ctx);
		const save = vi.fn(async () => {});
		const sync = vi.fn(async () => {});
		const openTui = vi.fn(async () => {});
		mgr.setConfig(configWithProfiles(["alpha"]));

		registerCommands(pi, mgr, save as any, vi.fn() as any, openTui, sync);

		const handlerFor = (command: string) =>
			(pi.registerCommand as any).mock.calls.find(
				(c: any[]) => c[0] === command,
			)[1].handler;
		await handlerFor("profiles:save")("snapshot", ctx);
		await handlerFor("profiles:sync")("", ctx);
		await handlerFor("profiles:list")("", ctx);

		expect(save).toHaveBeenCalledWith(ctx, "snapshot");
		expect(sync).toHaveBeenCalledWith(ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith("alpha");
		expect(openTui).not.toHaveBeenCalled();
	});
});
