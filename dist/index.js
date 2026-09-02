// src/extension.ts
import { readFileSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import {
  copyToClipboard,
  DynamicBorder,
  getAgentDir
} from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, Text } from "@earendil-works/pi-tui";

// src/constants.ts
var CONFIG_VERSION = 1;
var ACTIVE_ENTRY_TYPE = "pi-profiles:active";
var STATUS_KEY = "pi-profiles";
var DEFAULT_SHORTCUT = "ctrl+shift+p";
var LEGACY_SHORTCUT = "ctrl+alt+p";

// src/config.ts
var EFFORTS = /* @__PURE__ */ new Set([
  "inherit",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);
var SHORTCUT_REGEX = /^(?:(?:ctrl|alt|shift|meta)\+)+(?:[a-z0-9]|tab|f(?:[1-9]|1[0-2]))$/i;
var object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
var has = (value, key) => Object.hasOwn(value, key);
var normalizeAgent = (name) => name.trim().toLowerCase();
function supportedShortcut(key) {
  return SHORTCUT_REGEX.test(key);
}
function validatePersistedRoute(raw) {
  if (!object(raw)) return void 0;
  const result = {};
  if (has(raw, "model")) {
    if (raw.model === null) {
      result.model = null;
    } else if (object(raw.model) && typeof raw.model.provider === "string" && raw.model.provider.trim() && typeof raw.model.id === "string" && raw.model.id.trim()) {
      result.model = {
        provider: raw.model.provider.trim(),
        id: raw.model.id.trim()
      };
    } else {
      return void 0;
    }
  }
  if (has(raw, "effort")) {
    if (typeof raw.effort !== "string" || !EFFORTS.has(raw.effort)) {
      return void 0;
    }
    result.effort = raw.effort;
  }
  return Object.keys(result).length ? result : void 0;
}
function validateConfig(raw) {
  if (!object(raw) || raw.version !== CONFIG_VERSION || !object(raw.profiles)) {
    return { error: "expected version 1 and profiles object" };
  }
  const profiles = {};
  for (const [name, rawProfile] of Object.entries(raw.profiles)) {
    if (!name.trim() || !object(rawProfile) || !Number.isInteger(rawProfile.order)) {
      return { error: `invalid profile ${name}` };
    }
    const agents = {};
    if (rawProfile.agents !== void 0) {
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
    const orchestrator = rawProfile.orchestrator === void 0 ? void 0 : validatePersistedRoute(rawProfile.orchestrator);
    if (rawProfile.orchestrator !== void 0 && !orchestrator) {
      return { error: `invalid orchestrator in ${name}` };
    }
    profiles[name] = {
      order: rawProfile.order,
      ...orchestrator ? { orchestrator } : {},
      ...Object.keys(agents).length ? { agents } : {}
    };
  }
  const defaultProfile = raw.defaultProfile === void 0 ? void 0 : typeof raw.defaultProfile === "string" && raw.defaultProfile in profiles ? raw.defaultProfile : void 0;
  if (raw.defaultProfile !== void 0 && !defaultProfile) {
    return { error: "invalid defaultProfile reference" };
  }
  let cycle;
  if (raw.cycle !== void 0) {
    if (!Array.isArray(raw.cycle) || !raw.cycle.every(
      (name) => typeof name === "string" && name in profiles
    ) || new Set(raw.cycle).size !== raw.cycle.length) {
      return { error: "invalid cycle reference" };
    }
    cycle = raw.cycle;
  }
  if (raw.shortcut !== void 0 && (typeof raw.shortcut !== "string" || !raw.shortcut.trim())) {
    return { error: "invalid shortcut" };
  }
  return {
    config: {
      version: CONFIG_VERSION,
      ...defaultProfile ? { defaultProfile } : {},
      ...cycle ? { cycle } : {},
      shortcut: raw.shortcut === LEGACY_SHORTCUT ? DEFAULT_SHORTCUT : raw.shortcut ?? DEFAULT_SHORTCUT,
      profiles
    }
  };
}
function emptyConfig() {
  return { version: CONFIG_VERSION, profiles: {} };
}
function resolveDefaultRoute(route) {
  const result = {};
  if (route?.model) result.model = route.model;
  if (route?.effort && route.effort !== "inherit") {
    result.effort = route.effort;
  }
  return result;
}
function migrateV1(data) {
  if (!object(data)) return emptyConfig();
  if (has(data, "version")) return emptyConfig();
  const entries = [];
  if (object(data.profiles) && !Array.isArray(data.profiles)) {
    for (const [name, val] of Object.entries(data.profiles)) {
      if (object(val) && typeof val.model === "string") {
        entries.push([
          name,
          { model: val.model, thinking: String(val.thinking || "low") }
        ]);
      }
    }
  } else {
    for (const [name, val] of Object.entries(data)) {
      if (object(val) && typeof val.model === "string" && name !== "version") {
        entries.push([
          name,
          { model: val.model, thinking: String(val.thinking || "low") }
        ]);
      }
    }
  }
  const profiles = {};
  for (let i = 0; i < entries.length; i++) {
    const [name, old] = entries[i];
    const slash = old.model.indexOf("/");
    const provider = slash === -1 ? "" : old.model.slice(0, slash);
    const id = slash === -1 ? old.model : old.model.slice(slash + 1);
    profiles[name] = {
      order: i,
      orchestrator: {
        model: provider || id ? { provider, id } : void 0,
        effort: old.thinking || "low"
      }
    };
  }
  return {
    version: CONFIG_VERSION,
    shortcut: DEFAULT_SHORTCUT,
    profiles
  };
}

// src/commands.ts
var COMMAND_ACTIONS = [
  "list",
  "status",
  "sync",
  "use",
  "save",
  "next",
  "off"
];
function parseCommand(input) {
  const [verb = "", ...rest] = input.trim().split(/\s+/);
  return { verb: verb.toLowerCase(), name: rest.join(" ") };
}
function registerCommands(pi, manager, _save, _load, openTui = async () => {
}, sync = async () => {
}) {
  const handleAction = async (args, ctx) => {
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
      return openTui(ctx);
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error"
      );
    }
  };
  pi.registerCommand("profiles", {
    description: "Manage SDD model profiles",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart();
      const [action = "", ...nameParts] = trimmed.split(/\s+/);
      const verb = action.toLowerCase();
      if (!/\s/.test(trimmed)) {
        return COMMAND_ACTIONS.filter((value) => value.startsWith(verb)).map(
          (value) => ({ value, label: value })
        );
      }
      if (verb !== "use" && verb !== "save") return [];
      const namePrefix = nameParts.join(" ");
      return manager.names().filter((name) => name.startsWith(namePrefix)).map((value) => ({ value, label: value }));
    },
    handler: handleAction
  });
  for (const action of COMMAND_ACTIONS) {
    pi.registerCommand(`profiles:${action}`, {
      description: `PiProfiles: ${action}`,
      handler: (args, ctx) => handleAction(`${action} ${args}`.trim(), ctx)
    });
  }
}

// src/sync.ts
import { readdir } from "fs/promises";
async function discoverManagedAgentNames(agentsDir) {
  try {
    const entries = await readdir(agentsDir);
    return [...new Set(
      entries.filter((entry) => entry.endsWith(".md")).map((entry) => normalizeAgent(entry.slice(0, -3))).filter(Boolean)
    )].sort();
  } catch {
    return [];
  }
}
function reconcileProfileAgents(config, discoveredAgents) {
  const discovered = new Set(
    discoveredAgents.map(normalizeAgent).filter(Boolean)
  );
  let added = 0;
  let removed = 0;
  const profiles = Object.fromEntries(
    Object.entries(config.profiles).map(([name, profile]) => {
      const existing = profile.agents ?? {};
      const agents = {};
      for (const agent of discovered) {
        if (existing[agent]) {
          agents[agent] = existing[agent];
        } else {
          agents[agent] = profile.orchestrator?.model ? { model: { ...profile.orchestrator.model } } : { model: null };
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
          ...Object.keys(agents).length ? { agents } : {}
        }
      ];
    })
  );
  return { config: { ...config, profiles }, added, removed };
}

// src/session-state.ts
import { isAbsolute, resolve } from "path";
var object2 = (value) => !!value && typeof value === "object" && !Array.isArray(value);
function validRoute(value) {
  return object2(value) && Object.keys(value).every((key) => key === "model" || key === "effort") && (value.model === void 0 || object2(value.model) && typeof value.model.provider === "string" && !!value.model.provider.trim() && typeof value.model.id === "string" && !!value.model.id.trim()) && (value.effort === void 0 || typeof value.effort === "string");
}
function validSnapshot(data) {
  return object2(data) && typeof data.profile === "string" && !!data.profile && validRoute(data.route) && validRoute(data.baseline) && typeof data.activatedAt === "string" && (data.cwd === void 0 || typeof data.cwd === "string");
}
function normalizedCwd(value) {
  return typeof value === "string" && isAbsolute(value) ? resolve(value) : void 0;
}
var SessionState = class {
  active = /* @__PURE__ */ new Map();
  off = /* @__PURE__ */ new Set();
  get(id) {
    return id ? this.active.get(id) : void 0;
  }
  shouldDefault(id) {
    return !!id && !this.active.has(id) && !this.off.has(id);
  }
  clear(id) {
    if (id) {
      this.active.delete(id);
      this.off.delete(id);
    } else {
      this.active.clear();
      this.off.clear();
    }
  }
  activate(pi, ctx, snapshot) {
    const id = ctx.sessionManager.getSessionId();
    if (!id) return false;
    const cwd = normalizedCwd(ctx.cwd);
    if (cwd) {
      try {
        pi.appendEntry(ACTIVE_ENTRY_TYPE, { ...snapshot, cwd });
      } catch {
      }
    }
    this.off.delete(id);
    this.active.set(id, snapshot);
    return true;
  }
  deactivate(pi, ctx) {
    const id = ctx.sessionManager.getSessionId();
    if (!id) return false;
    const cwd = normalizedCwd(ctx.cwd);
    if (cwd) {
      try {
        pi.appendEntry(ACTIVE_ENTRY_TYPE, { off: true, cwd });
      } catch {
      }
    }
    this.active.delete(id);
    this.off.add(id);
    return true;
  }
  restore(ctx) {
    const id = ctx.sessionManager.getSessionId();
    const cwd = normalizedCwd(ctx.cwd);
    if (!id || !cwd) return void 0;
    let branch;
    try {
      branch = ctx.sessionManager.getBranch();
    } catch {
      return void 0;
    }
    for (const entry of [...branch].reverse()) {
      if (!object2(entry) || entry.type !== "custom" || entry.customType !== ACTIVE_ENTRY_TYPE) {
        continue;
      }
      const marker = entry.data;
      if (!marker || typeof marker !== "object") continue;
      if ("off" in marker && marker.off && normalizedCwd(marker.cwd) === cwd) {
        this.off.add(id);
        return void 0;
      }
      if (validSnapshot(marker) && normalizedCwd(marker.cwd) === cwd) {
        this.active.set(id, marker);
        return marker;
      }
    }
    return void 0;
  }
};

// src/profile-manager.ts
var ProfileManager = class {
  constructor(pi, ctx, applyAgentRoutes = async () => {
  }) {
    this.pi = pi;
    this.applyAgentRoutes = applyAgentRoutes;
    this.ctx = ctx;
  }
  pi;
  applyAgentRoutes;
  state = new SessionState();
  config = { version: 1, profiles: {} };
  ctx;
  setContext(ctx) {
    this.ctx = ctx;
  }
  setConfig(config) {
    this.config = config;
  }
  context() {
    if (!this.ctx) throw new Error("No active Pi context");
    return this.ctx;
  }
  names() {
    const ordered = Object.entries(this.config.profiles).sort((a, b) => a[1].order - b[1].order).map(([name]) => name);
    return this.config.cycle?.length ? this.config.cycle : ordered;
  }
  target(route, baseline) {
    const model = route?.model ?? baseline.model;
    const effort = route?.effort !== void 0 ? route.effort !== "inherit" ? route.effort : void 0 : baseline.effort;
    return {
      ...model ? { model } : {},
      ...effort ? { effort } : {}
    };
  }
  async apply(ctx, target) {
    if (target.model) {
      const model = ctx.modelRegistry.find(
        target.model.provider,
        target.model.id
      );
      if (!model) {
        throw new Error(
          `model ${target.model.provider}/${target.model.id} is unavailable`
        );
      }
      if (!await this.pi.setModel(model)) {
        throw new Error(
          `No API key for ${target.model.provider}/${target.model.id}`
        );
      }
    }
    if (target.effort !== void 0) {
      try {
        this.pi.setThinkingLevel(target.effort);
      } catch {
      }
    }
  }
  async use(name) {
    const ctx = this.context();
    const profile = this.config.profiles[name];
    if (!profile) throw new Error(`Unknown profile: ${name}`);
    const current = this.state.get(ctx.sessionManager.getSessionId());
    const baseline = current?.baseline ?? {
      ...ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : {},
      effort: this.pi.getThinkingLevel()
    };
    const target = this.target(profile.orchestrator, baseline);
    try {
      await this.apply(ctx, target);
      await this.applyAgentRoutes(
        profile.agents ?? {},
        current?.agentRoutes ?? Object.keys(
          current ? this.config.profiles[current.profile]?.agents ?? {} : {}
        )
      );
      const snapshot = {
        profile: name,
        route: resolveDefaultRoute(profile.orchestrator),
        baseline,
        agentRoutes: Object.keys(profile.agents ?? {}),
        activatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      this.state.activate(this.pi, ctx, snapshot);
      ctx.ui.setStatus(STATUS_KEY, name);
      return snapshot;
    } catch (error) {
      if (current) {
        try {
          await this.apply(ctx, this.target(current.route, current.baseline));
        } catch {
        }
      } else {
        try {
          await this.apply(ctx, baseline);
        } catch {
        }
      }
      throw error;
    }
  }
  async off() {
    const ctx = this.context();
    const active = this.state.get(ctx.sessionManager.getSessionId());
    if (!active) return;
    await this.apply(ctx, active.baseline);
    this.state.deactivate(this.pi, ctx);
    ctx.ui.setStatus(STATUS_KEY, void 0);
  }
  async next() {
    const names = this.names();
    if (!names.length) throw new Error("No profiles configured");
    const current = this.state.get(
      this.context().sessionManager.getSessionId()
    )?.profile;
    return this.use(
      names[(names.indexOf(current ?? "") + 1 + names.length) % names.length]
    );
  }
  resolveAgentRoute(agent, sessionId) {
    const active = this.state.get(sessionId);
    if (!active) return void 0;
    const profile = this.config.profiles[active.profile];
    const route = profile?.agents?.[normalizeAgent(agent)];
    return route ? resolveDefaultRoute(route) : void 0;
  }
};

// src/extension.ts
function readConfigSync(path) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw && typeof raw === "object" && !("version" in raw) ? migrateV1(raw) : validateConfig(raw).config ?? emptyConfig();
  } catch {
    return emptyConfig();
  }
}
async function readConfig(path) {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return raw && typeof raw === "object" && !("version" in raw) ? migrateV1(raw) : validateConfig(raw).config ?? emptyConfig();
  } catch {
    return emptyConfig();
  }
}
async function writeConfig(path, config) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2));
}
function chooser(ctx, title, items, height = 10) {
  return ctx.ui.custom((tui, theme, _kb, done) => {
    const container = new Container();
    const list = new SelectList(items, Math.min(items.length, height), {
      selectedPrefix: (value) => theme.fg("accent", value),
      selectedText: (value) => theme.fg("accent", value),
      description: (value) => theme.fg("muted", value),
      scrollInfo: (value) => theme.fg("dim", value),
      noMatch: (value) => theme.fg("warning", value)
    });
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);
    container.addChild(new DynamicBorder((value) => theme.fg("accent", value)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(list);
    container.addChild(new DynamicBorder((value) => theme.fg("accent", value)));
    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        list.handleInput(data);
        tui.requestRender();
      }
    };
  }, { overlay: true });
}
async function selectSubagents(ctx, agents) {
  const selected = /* @__PURE__ */ new Set();
  while (true) {
    const choice = await chooser(ctx, "Select subagents to update", [
      ...agents.map((agent2) => ({
        value: `toggle:${agent2}`,
        label: `${selected.has(agent2) ? "\u2611" : "\u2610"} ${agent2}`,
        description: "Toggle selection"
      })),
      { value: "confirm", label: `Continue with ${selected.size} selected` },
      { value: "cancel", label: "\u2190 Cancel" }
    ], Math.min(agents.length + 2, 12));
    if (!choice || choice === "cancel") return null;
    if (choice === "confirm") return selected.size ? agents.filter((agent2) => selected.has(agent2)) : null;
    if (!choice.startsWith("toggle:")) continue;
    const agent = choice.slice("toggle:".length);
    if (!agents.includes(agent)) continue;
    if (selected.has(agent)) selected.delete(agent);
    else selected.add(agent);
  }
}
function confirmBulkUpdate(ctx, action, agents, value) {
  return chooser(ctx, `Review bulk ${action} update`, [
    { value: "confirm", label: "\u2713 Apply update", description: `Affected subagents: ${agents.join(", ")} \u2192 ${value}` },
    { value: "cancel", label: "\u2190 Cancel (no changes)" }
  ], 2);
}
function searchableChooser(ctx, title, items) {
  return ctx.ui.custom((tui, theme, kb, done) => {
    const container = new Container();
    const input = new Input();
    input.focused = true;
    let query = "";
    const createList = (filtered) => {
      const list2 = new SelectList(filtered, 12, {
        selectedPrefix: (value) => theme.fg("accent", value),
        selectedText: (value) => theme.fg("accent", value),
        description: (value) => theme.fg("muted", value),
        scrollInfo: (value) => theme.fg("dim", value),
        noMatch: (value) => theme.fg("warning", value)
      });
      list2.onSelect = (item) => done(item.value);
      list2.onCancel = () => done(null);
      return list2;
    };
    let list = createList(items);
    const render = () => {
      container.clear();
      container.addChild(new DynamicBorder((value) => theme.fg("accent", value)));
      container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
      container.addChild(new Text(theme.fg("dim", "Type to search \u2022 Enter to select \u2022 Esc to cancel"), 1, 0));
      container.addChild(input);
      container.addChild(list);
      container.addChild(new DynamicBorder((value) => theme.fg("accent", value)));
    };
    render();
    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
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
      }
    };
  }, { overlay: true });
}
function prompt(ctx, title, initial = "") {
  return ctx.ui.custom((tui, theme, _kb, done) => {
    const container = new Container();
    const input = new Input();
    input.setValue?.(initial);
    input.focused = true;
    input.onSubmit = (value) => done(value.trim() || null);
    input.onEscape = () => done(null);
    container.addChild(new DynamicBorder((value) => theme.fg("accent", value)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(input);
    container.addChild(new DynamicBorder((value) => theme.fg("accent", value)));
    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        input.handleInput(data);
        tui.requestRender();
      }
    };
  }, { overlay: true });
}
function showExportDialog(ctx, profileName, exportString, copyPromise) {
  return ctx.ui.custom((tui, theme, _kb, done) => {
    const container = new Container();
    const statusText = new Text(theme.fg("accent", "Copying to clipboard..."), 1, 0);
    container.addChild(new DynamicBorder((value) => theme.fg("accent", value)));
    container.addChild(new Text(theme.fg("accent", theme.bold(`\u{1F4E4} Profile Export: '${profileName}'`)), 1, 0));
    container.addChild(statusText);
    container.addChild(new Text(theme.fg("dim", "Select string below to copy:"), 1, 0));
    container.addChild(new Text(theme.fg("accent", exportString), 1, 0));
    container.addChild(new Text(theme.fg("dim", "[ Press any key or Esc to close ]"), 1, 0));
    container.addChild(new DynamicBorder((value) => theme.fg("accent", value)));
    copyPromise.then(() => {
      statusText.setText(theme.fg("accent", "\u2713 Copy command sent to terminal clipboard."));
      container.invalidate();
      tui.requestRender();
    }).catch((error) => {
      statusText.setText(theme.fg("error", `Failed to copy: ${error instanceof Error ? error.message : String(error)}`));
      container.invalidate();
      tui.requestRender();
    });
    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        done();
        tui.requestRender();
      }
    };
  }, {
    overlay: true,
    overlayOptions: { anchor: "center" }
  });
}
function object3(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function profileAgentsFromGlobal(config) {
  const agents = {};
  if (!object3(config.model_profiles)) return agents;
  for (const [name, route] of Object.entries(config.model_profiles)) {
    if (!object3(route)) continue;
    const model = typeof route.model === "string" ? parseModel(route.model) : void 0;
    const effort = typeof route.effort === "string" ? route.effort : void 0;
    if (model || effort) agents[normalizeAgent(name)] = { ...model ? { model } : {}, ...effort ? { effort } : {} };
  }
  return agents;
}
async function readGlobalAgentConfig(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return object3(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function globalAgentRoute(route) {
  return {
    ...route.model ? { model: `${route.model.provider}/${route.model.id}` } : {},
    ...route.effort && route.effort !== "inherit" ? { effort: route.effort } : {}
  };
}
async function currentProfile(ctx, pi, config, agentConfigPath) {
  const orders = Object.values(config.profiles).map((profile) => profile.order);
  const agents = profileAgentsFromGlobal(await readGlobalAgentConfig(agentConfigPath));
  return {
    order: (orders.length ? Math.max(...orders) : -1) + 1,
    orchestrator: {
      ...ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : {},
      effort: pi.getThinkingLevel()
    },
    ...Object.keys(agents).length ? { agents } : {}
  };
}
function routeDescription(route) {
  const model = route?.model && `${route.model.provider}/${route.model.id}`;
  return `${model ?? "none"} (${route?.effort ?? "inherit"})`;
}
function parseModel(value) {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1 || value.indexOf("/", slash + 1) !== -1) return void 0;
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}
function importProfile(raw) {
  const prefix = "piprofile:1:";
  if (!raw.startsWith(prefix)) throw new Error("String must start with piprofile:1:");
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(raw.slice(prefix.length), "base64").toString("utf8"));
  } catch {
    throw new Error("Invalid PiProfile payload");
  }
  if (!object3(parsed) || parsed._type !== "piprofile" || parsed.version !== 1 || !parsed.profile) {
    throw new Error("Invalid PiProfile payload");
  }
  if (!object3(parsed.profile)) throw new Error("Invalid PiProfile payload");
  const candidate = parsed.profile;
  const name = candidate.name;
  if (typeof name !== "string" || !name.trim()) throw new Error("Invalid or missing profile name");
  const config = validateConfig({ version: 1, profiles: { [name]: candidate } }).config;
  if (config) return {
    name,
    profile: config.profiles[name],
    ...candidate.favorite === true ? { favorite: true } : {}
  };
  const oldRoute = (route) => {
    if (!object3(route) || typeof route.model !== "string" || typeof route.thinking !== "string") return void 0;
    const model = parseModel(route.model);
    if (!model) return void 0;
    return validateConfig({
      version: 1,
      profiles: { legacy: { order: 0, orchestrator: { model, effort: route.thinking } } }
    }).config?.profiles.legacy.orchestrator;
  };
  const orchestrator = oldRoute(candidate.orchestrator);
  if (!orchestrator) throw new Error("Invalid profile route");
  const agents = {};
  if (candidate.agents !== void 0) {
    if (!object3(candidate.agents)) throw new Error("Invalid agent overrides");
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
    profile: { order: 0, orchestrator, ...Object.keys(agents).length ? { agents } : {} },
    ...candidate.favorite === true ? { favorite: true } : {}
  };
}
function extension(pi) {
  const agentDir = getAgentDir();
  const configPath = join(agentDir, "pi-profiles", "config.json");
  const agentConfigPath = join(agentDir, "subagents.json");
  const manager = new ProfileManager(pi, void 0, async (routes, previousRoutes) => {
    const global = await readGlobalAgentConfig(agentConfigPath);
    const modelProfiles = object3(global.model_profiles) ? { ...global.model_profiles } : {};
    const previous = new Set(previousRoutes.map(normalizeAgent));
    for (const name of Object.keys(modelProfiles)) {
      if (previous.has(normalizeAgent(name))) delete modelProfiles[name];
    }
    for (const [name, route] of Object.entries(routes)) {
      const normalized = normalizeAgent(name);
      for (const existing of Object.keys(modelProfiles)) {
        if (normalizeAgent(existing) === normalized) delete modelProfiles[existing];
      }
      modelProfiles[normalized] = globalAgentRoute(route);
    }
    global.model_profiles = modelProfiles;
    await mkdir(dirname(agentConfigPath), { recursive: true });
    await writeFile(agentConfigPath, JSON.stringify(global, null, 2));
  });
  manager.setConfig(readConfigSync(configPath));
  const shortcut = manager.config.shortcut ?? DEFAULT_SHORTCUT;
  const shortcutOptions = {
    description: "Cycle agent profile",
    async handler(ctx) {
      manager.setContext(ctx);
      try {
        await manager.next();
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    }
  };
  try {
    pi.registerShortcut(
      supportedShortcut(shortcut) ? shortcut : DEFAULT_SHORTCUT,
      shortcutOptions
    );
  } catch {
  }
  async function persist(config) {
    await writeConfig(configPath, config);
    manager.setConfig(config);
  }
  async function selectModel(ctx, title, route) {
    let available = [];
    try {
      available = await ctx.modelRegistry.getAvailable();
    } catch {
    }
    const choices = [
      { value: "back", label: "\u2190 Back" },
      { value: "__CUSTOM__", label: "\u270E Type custom model identifier..." },
      ...available.map((model2) => `${model2.provider}/${model2.id}`).sort().map((value) => ({ value, label: value }))
    ];
    let selected = await searchableChooser(ctx, title, choices);
    if (!selected || selected === "back") return void 0;
    if (selected === "__CUSTOM__") selected = await prompt(ctx, "Custom model identifier:", route.model ? `${route.model.provider}/${route.model.id}` : "");
    if (!selected) return void 0;
    const model = parseModel(selected);
    if (!model) {
      ctx.ui.notify("Model must use provider/id", "error");
      return void 0;
    }
    return { ...route, model };
  }
  async function editRoute(ctx, profileName, agent) {
    while (true) {
      const profile = manager.config.profiles[profileName];
      const route = agent === "orchestrator" ? profile.orchestrator ?? {} : profile.agents?.[agent] ?? {};
      const action = await chooser(ctx, `Edit ${agent}`, [
        { value: "model", label: "Modify Model", description: routeDescription(route) },
        { value: "effort", label: "Modify Thinking", description: route.effort ?? "inherit" },
        { value: "delete", label: "\u2716 Remove Agent from profile" },
        { value: "back", label: "\u2190 Back" }
      ], 4);
      if (!action || action === "back") return;
      if (action === "delete") {
        if (agent === "orchestrator") {
          ctx.ui.notify("Cannot delete orchestrator", "error");
          continue;
        }
        const agents = { ...profile.agents };
        delete agents[agent];
        await persist({ ...manager.config, profiles: { ...manager.config.profiles, [profileName]: { ...profile, ...Object.keys(agents).length ? { agents } : {} } } });
        return;
      }
      const updated = action === "model" ? await selectModel(ctx, `Select Model for ${agent}`, route) : (() => chooser(ctx, `Thinking for ${agent}`, ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value2) => ({ value: value2, label: value2 })), 8))();
      const value = await updated;
      if (!value) continue;
      const nextRoute = typeof value === "string" ? { ...route, effort: value } : value;
      const nextProfile = agent === "orchestrator" ? { ...profile, orchestrator: nextRoute } : { ...profile, agents: { ...profile.agents, [agent]: nextRoute } };
      await persist({ ...manager.config, profiles: { ...manager.config.profiles, [profileName]: nextProfile } });
    }
  }
  async function editProfile(ctx, name) {
    while (true) {
      const profile = manager.config.profiles[name];
      const agents = Object.keys(profile.agents ?? {});
      const selected = await chooser(ctx, `Edit Profile '${name}'`, [
        { value: "orchestrator", label: "orchestrator", description: routeDescription(profile.orchestrator) },
        ...agents.map((agent2) => ({ value: agent2, label: agent2, description: routeDescription(profile.agents?.[agent2]) })),
        { value: "bulk-model", label: "\u270E Change selected subagents' models" },
        { value: "bulk-thinking", label: "\u270E Change selected subagents' thinking" },
        { value: "__ADD__", label: "\u2795 Add Subagent" },
        { value: "back", label: "\u2190 Back" }
      ]);
      if (!selected || selected === "back") return;
      if (selected === "bulk-model" || selected === "bulk-thinking") {
        const targets = await selectSubagents(ctx, agents);
        if (!targets) continue;
        const action = selected === "bulk-model" ? "model" : "thinking";
        const value = selected === "bulk-model" ? await selectModel(ctx, "Select Model for selected subagents", {}) : await chooser(ctx, "Thinking for selected subagents", ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"].map((option) => ({ value: option, label: option })), 8);
        if (!value) continue;
        const preview = typeof value === "string" ? value : routeDescription(value);
        if (await confirmBulkUpdate(ctx, action, targets, preview) !== "confirm") continue;
        const updatedAgents = { ...profile.agents };
        for (const agent2 of targets) {
          const route = updatedAgents[agent2] ?? {};
          updatedAgents[agent2] = typeof value === "string" ? { ...route, effort: value } : { ...route, model: value.model };
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
  async function openTui(ctx) {
    manager.setContext(ctx);
    while (true) {
      const config = manager.config;
      const active = manager.state.get(ctx.sessionManager.getSessionId())?.profile;
      const selected = await chooser(ctx, "Profiles Manager", [
        { value: "__CREATE__", label: "\u2728 Create New Profile from Current Config" },
        { value: "__IMPORT__", label: "\u{1F4E5} Import Profile from String" },
        ...manager.names().map((name) => ({ value: name, label: `${name}${name === active ? " [\u25B6 Active]" : ""}${name === config.defaultProfile ? " [\u2605 Favorite]" : ""}`, description: routeDescription(config.profiles[name].orchestrator) }))
      ]);
      if (!selected) return;
      if (selected === "__CREATE__") {
        const name = await prompt(ctx, "Enter new profile name:");
        if (!name) continue;
        const fresh = await readConfig(configPath);
        if (fresh.profiles[name]) {
          ctx.ui.notify(`Profile '${name}' already exists`, "error");
          continue;
        }
        const profile = await currentProfile(ctx, pi, fresh, agentConfigPath);
        await persist({ ...fresh, ...fresh.cycle ? { cycle: [...fresh.cycle, name] } : {}, profiles: { ...fresh.profiles, [name]: profile } });
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
            ...imported.favorite ? { defaultProfile: name } : {},
            ...manager.config.cycle ? { cycle: [...manager.config.cycle, name] } : {},
            profiles: { ...manager.config.profiles, [name]: { ...imported.profile, order } }
          });
          ctx.ui.notify(`Imported profile '${name}'`, "info");
        } catch (error) {
          ctx.ui.notify(`Invalid profile string: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        continue;
      }
      const action = await chooser(ctx, `Profile: '${selected}'`, [
        { value: "activate", label: "\u25B6 Activate" },
        { value: "favorite", label: "\u2605 Set as Favorite" },
        { value: "edit", label: "\u270E Edit" },
        { value: "export", label: "\u{1F4E4} Export to String" },
        { value: "delete", label: "\u2716 Delete" },
        { value: "back", label: "\u2190 Back" }
      ], 6);
      if (!action || action === "back") continue;
      if (action === "activate") {
        await manager.use(selected);
        return;
      }
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
            favorite: selected === manager.config.defaultProfile
          }
        })).toString("base64");
        const exportString = `piprofile:1:${encoded}`;
        const copyPromise = copyToClipboard(exportString);
        await showExportDialog(ctx, selected, exportString, copyPromise);
        continue;
      }
      if (action === "delete") {
        const profiles = { ...manager.config.profiles };
        delete profiles[selected];
        const { defaultProfile, cycle, ...rest } = manager.config;
        await persist({
          ...rest,
          ...defaultProfile && defaultProfile !== selected ? { defaultProfile } : {},
          ...cycle ? { cycle: cycle.filter((name) => name !== selected) } : {},
          profiles
        });
        ctx.ui.notify(`Deleted profile '${selected}'.`, "info");
        continue;
      }
      await editProfile(ctx, selected);
    }
  }
  pi.on("session_start", async (_event, ctx) => {
    const context = ctx;
    manager.setContext(context);
    manager.setConfig(readConfigSync(configPath));
    const restored = manager.state.restore(context);
    const name = restored?.profile ?? (manager.state.shouldDefault(context.sessionManager.getSessionId()) ? manager.config.defaultProfile : void 0);
    if (name) try {
      await manager.use(name);
    } catch {
      manager.state.clear(context.sessionManager.getSessionId());
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const context = ctx;
    manager.state.clear(context.sessionManager.getSessionId());
    context.ui.setStatus(STATUS_KEY, void 0);
  });
  registerCommands(pi, manager, async (ctx, name) => {
    const fresh = await readConfig(configPath);
    const profile = await currentProfile(ctx, pi, fresh, agentConfigPath);
    const cycle = fresh.cycle && !fresh.cycle.includes(name) ? [...fresh.cycle, name] : fresh.cycle;
    await persist({
      ...fresh,
      ...cycle ? { cycle } : {},
      profiles: { ...fresh.profiles, [name]: profile }
    });
    ctx.ui.notify(`Saved profile '${name}'`, "info");
  }, async () => {
  }, openTui, async (ctx) => {
    const agents = await discoverManagedAgentNames(join(agentDir, "agents"));
    const result = reconcileProfileAgents(await readConfig(configPath), agents);
    await persist(result.config);
    ctx.ui.notify(`Profiles synced: +${result.added}, -${result.removed}`, "info");
  });
}
export {
  extension as default
};
