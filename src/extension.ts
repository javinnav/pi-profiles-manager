import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  copyToClipboard,
  DynamicBorder,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Container, Input, matchesKey, SelectList, Text } from "@earendil-works/pi-tui";
import { registerCommands } from "./commands.js";
import { emptyConfig, migrateV1, normalizeAgent, supportedShortcut, validateConfig } from "./config.js";
import { DEFAULT_SHORTCUT, STATUS_KEY } from "./constants.js";
import { ProfileManager } from "./profile-manager.js";
import { discoverManagedAgentNames, reconcileProfileAgents } from "./sync.js";
import type {
  Config,
  ContextLike,
  ModelRef,
  PersistedRoute,
  PiLike,
  Profile,
  ThinkingLevel,
} from "./types.js";

type Item = { value: string; label: string; description?: string };

function readConfigSync(path: string): Config {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw && typeof raw === "object" && !("version" in raw)
      ? migrateV1(raw)
      : (validateConfig(raw).config ?? emptyConfig());
  } catch {
    return emptyConfig();
  }
}

async function readConfig(path: string): Promise<Config> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return raw && typeof raw === "object" && !("version" in raw)
      ? migrateV1(raw)
      : (validateConfig(raw).config ?? emptyConfig());
  } catch {
    return emptyConfig();
  }
}

async function writeConfig(path: string, config: Config): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2));
}

function chooser(ctx: ContextLike, title: string, items: Item[], height = 10): Promise<string | null> {
  return (ctx.ui.custom as any)((tui: any, theme: any, _kb: any, done: any) => {
    const container = new Container() as any;
    const list = new SelectList(items, Math.min(items.length, height), {
      selectedPrefix: (value: string) => theme.fg("accent", value),
      selectedText: (value: string) => theme.fg("accent", value),
      description: (value: string) => theme.fg("muted", value),
      scrollInfo: (value: string) => theme.fg("dim", value),
      noMatch: (value: string) => theme.fg("warning", value),
    });
    list.onSelect = (item: Item) => done(item.value);
    list.onCancel = () => done(null);
    container.addChild(new DynamicBorder((value: string) => theme.fg("accent", value)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(list);
    container.addChild(new DynamicBorder((value: string) => theme.fg("accent", value)));
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
    };
  }, { overlay: true });
}

async function selectSubagents(ctx: ContextLike, agents: string[]): Promise<string[] | null> {
  const selected = new Set<string>();
  while (true) {
    const choice = await chooser(ctx, "Select subagents to update", [
      ...agents.map((agent) => ({
        value: `toggle:${agent}`,
        label: `${selected.has(agent) ? "☑" : "☐"} ${agent}`,
        description: "Toggle selection",
      })),
      { value: "confirm", label: `Continue with ${selected.size} selected` },
      { value: "cancel", label: "← Cancel" },
    ], Math.min(agents.length + 2, 12));
    if (!choice || choice === "cancel") return null;
    if (choice === "confirm") return selected.size ? agents.filter((agent) => selected.has(agent)) : null;
    if (!choice.startsWith("toggle:")) continue;
    const agent = choice.slice("toggle:".length);
    if (!agents.includes(agent)) continue;
    if (selected.has(agent)) selected.delete(agent);
    else selected.add(agent);
  }
}

function confirmBulkUpdate(ctx: ContextLike, action: string, agents: string[], value: string): Promise<string | null> {
  return chooser(ctx, `Review bulk ${action} update`, [
    { value: "confirm", label: "✓ Apply update", description: `Affected subagents: ${agents.join(", ")} → ${value}` },
    { value: "cancel", label: "← Cancel (no changes)" },
  ], 2);
}

function searchableChooser(ctx: ContextLike, title: string, items: Item[]): Promise<string | null> {
  return (ctx.ui.custom as any)((tui: any, theme: any, kb: any, done: any) => {
    const container = new Container() as any;
    const input = new Input() as any;
    input.focused = true;
    let query = "";
    const createList = (filtered: Item[]) => {
      const list = new SelectList(filtered, 12, {
        selectedPrefix: (value: string) => theme.fg("accent", value),
        selectedText: (value: string) => theme.fg("accent", value),
        description: (value: string) => theme.fg("muted", value),
        scrollInfo: (value: string) => theme.fg("dim", value),
        noMatch: (value: string) => theme.fg("warning", value),
      });
      list.onSelect = (item: Item) => done(item.value);
      list.onCancel = () => done(null);
      return list;
    };
    let list = createList(items);
    const render = () => {
      container.clear();
      container.addChild(new DynamicBorder((value: string) => theme.fg("accent", value)));
      container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
      container.addChild(new Text(theme.fg("dim", "Type to search • Enter to select • Esc to cancel"), 1, 0));
      container.addChild(input);
      container.addChild(list);
      container.addChild(new DynamicBorder((value: string) => theme.fg("accent", value)));
    };
    render();
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down") || kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.select.cancel")) {
          list.handleInput(data);
        } else {
          input.handleInput(data);
          const value = input.getValue();
          if (value !== query) {
            query = value;
            list = createList(items.filter((item) => item.value === "back" || item.value === "__CUSTOM__" || item.label.toLowerCase().includes(query.toLowerCase())));
            render();
          }
        }
        tui.requestRender();
      },
    };
  }, { overlay: true });
}

function prompt(ctx: ContextLike, title: string, initial = ""): Promise<string | null> {
  return (ctx.ui.custom as any)((tui: any, theme: any, _kb: any, done: any) => {
    const container = new Container() as any;
    const input = new Input() as any;
    input.setValue?.(initial);
    input.focused = true;
    input.onSubmit = (value: string) => done(value.trim() || null);
    input.onEscape = () => done(null);
    container.addChild(new DynamicBorder((value: string) => theme.fg("accent", value)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(input);
    container.addChild(new DynamicBorder((value: string) => theme.fg("accent", value)));
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => { input.handleInput(data); tui.requestRender(); },
    };
  }, { overlay: true });
}

function showExportDialog(ctx: ContextLike, profileName: string, exportString: string, copyPromise: Promise<void>): Promise<void> {
  return (ctx.ui.custom as (factory: unknown, options?: unknown) => Promise<void>)((tui: { requestRender: () => void }, theme: { fg: (color: string, text: string) => string; bold: (text: string) => string }, _kb: unknown, done: (value: void) => void) => {
    const container = new Container() as { addChild: (child: unknown) => void; render: (width: number) => unknown; invalidate: () => void };
    const statusText = new Text(theme.fg("accent", "Copying to clipboard..."), 1, 0);

    container.addChild(new DynamicBorder((value: string) => theme.fg("accent", value)));
    container.addChild(new Text(theme.fg("accent", theme.bold(`📤 Profile Export: '${profileName}'`)), 1, 0));
    container.addChild(statusText);
    container.addChild(new Text(theme.fg("dim", "Select string below to copy:"), 1, 0));
    const CHUNK_SIZE = 60;
    for (let i = 0; i < exportString.length; i += CHUNK_SIZE) {
      const chunk = exportString.slice(i, i + CHUNK_SIZE).padEnd(80, " ");
      container.addChild(new Text(theme.fg("accent", chunk), 1, 0));
    }
    container.addChild(new Text(theme.fg("dim", "[ Press any key or Esc to close ]"), 1, 0));
    container.addChild(new DynamicBorder((value: string) => theme.fg("accent", value)));

    copyPromise.then(() => {
      statusText.setText(theme.fg("accent", "✓ Copy command sent to terminal clipboard."));
      container.invalidate();
      tui.requestRender();
    }).catch((error) => {
      statusText.setText(theme.fg("error", `Failed to copy: ${error instanceof Error ? error.message : String(error)}`));
      container.invalidate();
      tui.requestRender();
    });

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        done();
        tui.requestRender();
      },
    };
  }, {
    overlay: true,
    overlayOptions: { anchor: "center" },
  });
}

type GlobalAgentRoute = { model?: string; effort?: ThinkingLevel };
type GlobalAgentConfig = { model_profiles?: Record<string, unknown>; [key: string]: unknown };

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function profileAgentsFromGlobal(config: GlobalAgentConfig): Record<string, PersistedRoute> {
  const agents: Record<string, PersistedRoute> = {};
  if (!object(config.model_profiles)) return agents;
  for (const [name, route] of Object.entries(config.model_profiles)) {
    if (!object(route)) continue;
    const model = typeof route.model === "string" ? parseModel(route.model) : undefined;
    const effort = typeof route.effort === "string" ? route.effort as ThinkingLevel : undefined;
    if (model || effort) agents[normalizeAgent(name)] = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  }
  return agents;
}

async function readGlobalAgentConfig(path: string): Promise<GlobalAgentConfig> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return object(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function readActivationGlobalAgentConfig(path: string): Promise<GlobalAgentConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (object(error) && error.code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!object(parsed)) {
    throw new Error("Invalid subagents configuration: expected an object");
  }
  return parsed;
}

function globalAgentRoute(route: PersistedRoute): GlobalAgentRoute | undefined {
  const result: GlobalAgentRoute = {
    ...(route.model ? { model: `${route.model.provider}/${route.model.id}` } : {}),
    ...(route.effort !== undefined && route.effort !== "inherit" ? { effort: route.effort } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

function normalizedAgentNames(names: readonly string[]): Set<string> {
  return new Set(names.map(normalizeAgent).filter((name) => name.length > 0));
}

function reconcileManagedAgentRoutes(
  global: GlobalAgentConfig,
  routes: Readonly<Record<string, PersistedRoute>>,
  ownedAgentNames: readonly string[],
): GlobalAgentConfig {
  const owned = normalizedAgentNames(ownedAgentNames);
  const nextModelProfiles: Record<string, unknown> = {};
  const existingModelProfiles = object(global.model_profiles)
    ? global.model_profiles
    : {};

  for (const [name, route] of Object.entries(existingModelProfiles)) {
    if (!owned.has(normalizeAgent(name))) nextModelProfiles[name] = route;
  }
  for (const [name, route] of Object.entries(routes)) {
    const normalized = normalizeAgent(name);
    if (!normalized) continue;
    const runtimeRoute = globalAgentRoute(route);
    if (runtimeRoute) nextModelProfiles[normalized] = runtimeRoute;
  }
  return { ...global, model_profiles: nextModelProfiles };
}

async function writeActivationGlobalAgentConfig(
  path: string,
  config: GlobalAgentConfig,
): Promise<void> {
  const serialized = JSON.stringify(config, null, 2);
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${randomUUID()}.tmp`,
  );

  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, serialized);
    await rename(temporaryPath, path);
    return;
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // Preserve the pre-commit error if cleanup also fails.
    }
    throw error;
  }
}

async function currentProfile(ctx: ContextLike, pi: PiLike, config: Config, agentConfigPath: string): Promise<Profile> {
  const orders = Object.values(config.profiles).map((profile) => profile.order);
  const agents = profileAgentsFromGlobal(await readGlobalAgentConfig(agentConfigPath));
  return {
    order: (orders.length ? Math.max(...orders) : -1) + 1,
    orchestrator: {
      ...(ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : {}),
      effort: pi.getThinkingLevel(),
    },
    ...(Object.keys(agents).length ? { agents } : {}),
  };
}

function routeDescription(route: PersistedRoute | undefined): string {
  const model = route?.model && `${route.model.provider}/${route.model.id}`;
  return `${model ?? "none"} (${route?.effort ?? "inherit"})`;
}

function parseModel(value: string): ModelRef | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1 || value.indexOf("/", slash + 1) !== -1) return undefined;
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

function importProfile(raw: string): { name: string; profile: Profile; favorite?: boolean } {
  raw = raw.replace(/\s+/g, "");
  const prefix = "piprofile:1:";
  if (!raw.startsWith(prefix)) throw new Error("String must start with piprofile:1:");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw.slice(prefix.length), "base64").toString("utf8"));
  } catch {
    throw new Error("Invalid PiProfile payload");
  }
  if (!object(parsed) || parsed._type !== "piprofile" || parsed.version !== 1 || !parsed.profile) {
    throw new Error("Invalid PiProfile payload");
  }
  if (!object(parsed.profile)) throw new Error("Invalid PiProfile payload");
  const candidate = parsed.profile;
  const name = candidate.name;
  if (typeof name !== "string" || !name.trim()) throw new Error("Invalid or missing profile name");
  const config = validateConfig({ version: 1, profiles: { [name]: candidate } }).config;
  if (config) return {
    name,
    profile: config.profiles[name],
    ...(candidate.favorite === true ? { favorite: true } : {}),
  };

  // Accept prior export strings while storing only validated typed routes.
  const oldRoute = (route: unknown): PersistedRoute | undefined => {
    if (!object(route) || typeof route.model !== "string" || typeof route.thinking !== "string") return undefined;
    const model = parseModel(route.model);
    if (!model) return undefined;
    return validateConfig({
      version: 1,
      profiles: { legacy: { order: 0, orchestrator: { model, effort: route.thinking } } },
    }).config?.profiles.legacy.orchestrator;
  };
  const orchestrator = oldRoute(candidate.orchestrator);
  if (!orchestrator) throw new Error("Invalid profile route");
  const agents: Record<string, PersistedRoute> = {};
  if (candidate.agents !== undefined) {
    if (!object(candidate.agents)) throw new Error("Invalid agent overrides");
    for (const [agent, route] of Object.entries(candidate.agents)) {
      const normalized = normalizeAgent(agent);
      const parsedRoute = oldRoute(route);
      if (!normalized || !parsedRoute || agents[normalized]) {
        throw new Error(`Invalid agent override ${agent}`);
      }
      agents[normalized] = parsedRoute;
    }
  }
  return {
    name,
    profile: { order: 0, orchestrator, ...(Object.keys(agents).length ? { agents } : {}) },
    ...(candidate.favorite === true ? { favorite: true } : {}),
  };
}

export default function extension(pi: PiLike) {
  const agentDir = getAgentDir();
  const configPath = join(agentDir, "pi-profiles", "config.json");
  const agentConfigPath = join(agentDir, "subagents.json");
  const manager = new ProfileManager(pi, undefined, async (routes, ownedAgentNames) => {
    const global = await readActivationGlobalAgentConfig(agentConfigPath);
    const nextGlobal = reconcileManagedAgentRoutes(global, routes, ownedAgentNames);
    await writeActivationGlobalAgentConfig(agentConfigPath, nextGlobal);
  });
  manager.setConfig(readConfigSync(configPath));

  const shortcut = manager.config.shortcut ?? DEFAULT_SHORTCUT;
  const shortcutOptions = {
    description: "Cycle agent profile",
    async handler(ctx: ContextLike) {
      manager.setContext(ctx);
      try { await manager.next(); } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  };
  try {
    pi.registerShortcut(
      (supportedShortcut(shortcut) ? shortcut : DEFAULT_SHORTCUT) as Parameters<PiLike["registerShortcut"]>[0],
      shortcutOptions,
    );
  } catch { /* shortcut collisions are non-fatal */ }

  async function persist(config: Config) {
    await writeConfig(configPath, config);
    manager.setConfig(config);
  }

  async function selectModel(ctx: ContextLike, title: string, route: PersistedRoute): Promise<PersistedRoute | undefined> {
    let available: any[] = [];
    try { available = await (ctx.modelRegistry as any).getAvailable(); } catch { /* custom remains available */ }
    const choices: Item[] = [
      { value: "back", label: "← Back" },
      { value: "__CUSTOM__", label: "✎ Type custom model identifier..." },
      ...available.map((model) => `${model.provider}/${model.id}`).sort().map((value) => ({ value, label: value })),
    ];
    let selected = await searchableChooser(ctx, title, choices);
    if (!selected || selected === "back") return undefined;
    if (selected === "__CUSTOM__") selected = await prompt(ctx, "Custom model identifier:", route.model ? `${route.model.provider}/${route.model.id}` : "");
    if (!selected) return undefined;
    const model = parseModel(selected);
    if (!model) { ctx.ui.notify("Model must use provider/id", "error"); return undefined; }
    return { ...route, model };
  }

  async function editRoute(ctx: ContextLike, profileName: string, agent: string) {
    while (true) {
      const profile = manager.config.profiles[profileName];
      const route = agent === "orchestrator" ? (profile.orchestrator ?? {}) : (profile.agents?.[agent] ?? {});
      const action = await chooser(ctx, `Edit ${agent}`, [
        { value: "model", label: "Modify Model", description: routeDescription(route) },
        { value: "effort", label: "Modify Thinking", description: route.effort ?? "inherit" },
        { value: "delete", label: "✖ Remove Agent from profile" },
        { value: "back", label: "← Back" },
      ], 4);
      if (!action || action === "back") return;
      if (action === "delete") {
        if (agent === "orchestrator") { ctx.ui.notify("Cannot delete orchestrator", "error"); continue; }
        const agents = { ...profile.agents }; delete agents[agent];
        await persist({ ...manager.config, profiles: { ...manager.config.profiles, [profileName]: { ...profile, ...(Object.keys(agents).length ? { agents } : {}) } } });
        return;
      }
      const updated = action === "model"
        ? await selectModel(ctx, `Select Model for ${agent}`, route)
        : (() => chooser(ctx, `Thinking for ${agent}`, ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: value })), 8))();
      const value = await updated;
      if (!value) continue;
      const nextRoute = typeof value === "string" ? { ...route, effort: value as ThinkingLevel } : value;
      const nextProfile = agent === "orchestrator"
        ? { ...profile, orchestrator: nextRoute }
        : { ...profile, agents: { ...profile.agents, [agent]: nextRoute } };
      await persist({ ...manager.config, profiles: { ...manager.config.profiles, [profileName]: nextProfile } });
    }
  }

  async function editProfile(ctx: ContextLike, name: string) {
    while (true) {
      const profile = manager.config.profiles[name];
      const agents = Object.keys(profile.agents ?? {});
      const selected = await chooser(ctx, `Edit Profile '${name}'`, [
        { value: "orchestrator", label: "orchestrator", description: routeDescription(profile.orchestrator) },
        ...agents.map((agent) => ({ value: agent, label: agent, description: routeDescription(profile.agents?.[agent]) })),
        { value: "bulk-model", label: "✎ Change selected subagents' models" },
        { value: "bulk-thinking", label: "✎ Change selected subagents' thinking" },
        { value: "__ADD__", label: "➕ Add Subagent" },
        { value: "back", label: "← Back" },
      ]);
      if (!selected || selected === "back") return;
      if (selected === "bulk-model" || selected === "bulk-thinking") {
        const targets = await selectSubagents(ctx, agents);
        if (!targets) continue;
        const action = selected === "bulk-model" ? "model" : "thinking";
        const value = selected === "bulk-model"
          ? await selectModel(ctx, "Select Model for selected subagents", {})
          : await chooser(ctx, "Thinking for selected subagents", ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"].map((option) => ({ value: option, label: option })), 8);
        if (!value) continue;
        const preview = typeof value === "string" ? value : routeDescription(value);
        if (await confirmBulkUpdate(ctx, action, targets, preview) !== "confirm") continue;
        const updatedAgents = { ...profile.agents };
        for (const agent of targets) {
          const route = updatedAgents[agent] ?? {};
          updatedAgents[agent] = typeof value === "string"
            ? { ...route, effort: value as ThinkingLevel }
            : { ...route, model: value.model };
        }
        await persist({ ...manager.config, profiles: { ...manager.config.profiles, [name]: { ...profile, agents: updatedAgents } } });
        continue;
      }
      let agent = selected;
      if (agent === "__ADD__") {
        const entered = await prompt(ctx, "Subagent Name (e.g. sdd-apply):");
        if (!entered) continue;
        agent = entered.trim().toLowerCase();
        if (!agent) continue;
        await persist({ ...manager.config, profiles: { ...manager.config.profiles, [name]: { ...profile, agents: { ...profile.agents, [agent]: { effort: "low" } } } } });
      }
      await editRoute(ctx, name, agent);
    }
  }

  async function openTui(ctx: ContextLike) {
    manager.setContext(ctx);
    while (true) {
      const config = manager.config;
      const active = manager.state.get(ctx.sessionManager.getSessionId())?.profile;
      const selected = await chooser(ctx, "Profiles Manager", [
        { value: "__CREATE__", label: "✨ Create New Profile from Current Config" },
        { value: "__IMPORT__", label: "📥 Import Profile from String" },
        ...manager.names().map((name) => ({ value: name, label: `${name}${name === active ? " [▶ Active]" : ""}${name === config.defaultProfile ? " [★ Favorite]" : ""}`, description: routeDescription(config.profiles[name].orchestrator) })),
      ]);
      if (!selected) return;
      if (selected === "__CREATE__") {
        const name = await prompt(ctx, "Enter new profile name:");
        if (!name) continue;
        const fresh = await readConfig(configPath);
        if (fresh.profiles[name]) { ctx.ui.notify(`Profile '${name}' already exists`, "error"); continue; }
        const profile = await currentProfile(ctx, pi, fresh, agentConfigPath);
        await persist({ ...fresh, ...(fresh.cycle ? { cycle: [...fresh.cycle, name] } : {}), profiles: { ...fresh.profiles, [name]: profile } });
        ctx.ui.notify(`Created profile '${name}'`, "info");
        continue;
      }
      if (selected === "__IMPORT__") {
        const raw = await prompt(ctx, "Paste profile export string:");
        if (!raw) continue;
        try {
          const imported = importProfile(raw.trim());
          let name = imported.name;
          while (manager.config.profiles[name]) name += "-imported";
          const order = Math.max(-1, ...Object.values(manager.config.profiles).map((profile) => profile.order)) + 1;
          await persist({
            ...manager.config,
            ...(imported.favorite ? { defaultProfile: name } : {}),
            ...(manager.config.cycle ? { cycle: [...manager.config.cycle, name] } : {}),
            profiles: { ...manager.config.profiles, [name]: { ...imported.profile, order } },
          });
          ctx.ui.notify(`Imported profile '${name}'`, "info");
        } catch (error) { ctx.ui.notify(`Invalid profile string: ${error instanceof Error ? error.message : String(error)}`, "error"); }
        continue;
      }
      const action = await chooser(ctx, `Profile: '${selected}'`, [
        { value: "activate", label: "▶ Activate" },
        { value: "favorite", label: "★ Set as Favorite" },
        { value: "edit", label: "✎ Edit" },
        { value: "export", label: "📤 Export to String" },
        { value: "delete", label: "✖ Delete" },
        { value: "back", label: "← Back" },
      ], 6);
      if (!action || action === "back") continue;
      if (action === "activate") { await manager.use(selected); return; }
      if (action === "favorite") {
        await persist({ ...manager.config, defaultProfile: selected });
        ctx.ui.notify(`Set '${selected}' as favorite.`, "info");
        continue;
      }
      if (action === "export") {
        const encoded = Buffer.from(JSON.stringify({
          _type: "piprofile",
          version: 1,
          profile: {
            name: selected,
            ...manager.config.profiles[selected],
            favorite: selected === manager.config.defaultProfile,
          },
        })).toString("base64");
        const exportString = `piprofile:1:${encoded}`;
        const copyPromise = copyToClipboard(exportString);
        await showExportDialog(ctx, selected, exportString, copyPromise);
        continue;
      }
      if (action === "delete") {
        const profiles = { ...manager.config.profiles }; delete profiles[selected];
        const { defaultProfile, cycle, ...rest } = manager.config;
        await persist({
          ...rest,
          ...(defaultProfile && defaultProfile !== selected ? { defaultProfile } : {}),
          ...(cycle ? { cycle: cycle.filter((name) => name !== selected) } : {}),
          profiles,
        });
        ctx.ui.notify(`Deleted profile '${selected}'.`, "info");
        continue;
      }
      await editProfile(ctx, selected);
    }
  }

  pi.on("session_start", async (_event: unknown, ctx: unknown) => {
    const context = ctx as ContextLike;
    manager.setContext(context);
    manager.setConfig(readConfigSync(configPath));
    const restored = manager.state.restore(context);
    const name = restored?.profile ?? (manager.state.shouldDefault(context.sessionManager.getSessionId()) ? manager.config.defaultProfile : undefined);
    if (name) try { await manager.use(name); } catch { manager.state.clear(context.sessionManager.getSessionId()); }
  });
  pi.on("session_shutdown", async (_event: unknown, ctx: unknown) => {
    const context = ctx as ContextLike;
    manager.state.clear(context.sessionManager.getSessionId());
    context.ui.setStatus(STATUS_KEY, undefined);
  });

  registerCommands(pi, manager, async (ctx, name) => {
    const fresh = await readConfig(configPath);
    const profile = await currentProfile(ctx as ContextLike, pi, fresh, agentConfigPath);
    const cycle = fresh.cycle && !fresh.cycle.includes(name)
      ? [...fresh.cycle, name]
      : fresh.cycle;
    await persist({
      ...fresh,
      ...(cycle ? { cycle } : {}),
      profiles: { ...fresh.profiles, [name]: profile },
    });
    ctx.ui.notify(`Saved profile '${name}'`, "info");
  }, async () => {}, openTui, async (ctx) => {
    const agents = await discoverManagedAgentNames(join(agentDir, "agents"));
    const result = reconcileProfileAgents(await readConfig(configPath), agents);
    await persist(result.config);
    ctx.ui.notify(`Profiles synced: +${result.added}, -${result.removed}`, "info");
  });
}
