import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, Input } from "@earendil-works/pi-tui";
import { supportedShortcut } from "./src/config.js";
import { STATUS_KEY } from "./src/constants.js";

const GENTLE_DIR = path.join(os.homedir(), ".pi", "gentle-ai");
const MODELS_PATH = path.join(GENTLE_DIR, "models.json");
const PROFILES_PATH = path.join(GENTLE_DIR, "sdd-profiles-manager.json");
const AGENT_HOME =
  process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const SETTINGS_PATH = path.join(AGENT_HOME, "settings.json");
const SUBAGENTS_PATH = path.join(AGENT_HOME, "subagents.json");

interface Profile {
  name: string;
  orchestrator: { model: string; thinking: string };
  agents: Record<string, { model: string; thinking: string }>;
  favorite?: boolean;
}

async function readJson(fp: string): Promise<any> {
  try {
    const data = await fs.readFile(fp, "utf-8");
    return JSON.parse(data);
  } catch (e: any) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
}

async function writeJson(fp: string, data: any): Promise<void> {
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(data, null, 2));
}

async function applyProfileModels(profile: Profile): Promise<void> {
  const currentModels = await readJson(MODELS_PATH);
  const newModels: Record<string, { model: string; thinking: string }> = {
    ...currentModels,
    ...(profile.orchestrator
      ? { "gentle-orchestrator": profile.orchestrator }
      : {}),
    ...(profile.agents ?? {}),
  };
  await writeJson(MODELS_PATH, newModels);

  // pi-subagents resolves effective routing from subagents.json, not models.json.
  const subagentsConfig = await readJson(SUBAGENTS_PATH);
  const modelProfiles = { ...(subagentsConfig.model_profiles ?? {}) };
  for (const [name, route] of Object.entries(profile.agents ?? {})) {
    modelProfiles[name] = {
      model: route.model,
      effort: route.thinking,
    };
  }
  await writeJson(SUBAGENTS_PATH, {
    ...subagentsConfig,
    model_profiles: modelProfiles,
  });
}

/**
 * Parse "provider/model-id" into { provider, model }.
 * Handles edge cases: "provider/" → model="", "/" → both empty, bare "model" → provider=""/model="model".
 */
function parseModelString(modelStr: string): {
  provider: string;
  model: string;
} {
  if (!modelStr) return { provider: "", model: "" };
  const slash = modelStr.indexOf("/");
  if (slash === -1) return { provider: "", model: modelStr };
  return {
    provider: modelStr.slice(0, slash),
    model: modelStr.slice(slash + 1),
  };
}

/**
 * Apply orchestrator model as the main model in real time.
 * Writes settings.json for persistence and calls pi.setModel() for immediate effect.
 */
async function applyMainModel(
  pi: ExtensionAPI,
  ctx: any,
  orchestratorModel: string,
): Promise<void> {
  const { provider, model } = parseModelString(orchestratorModel);
  if (!provider && !model) return;

  // Find the model in the registry
  const modelObj = ctx.modelRegistry.find(provider, model);
  if (!modelObj) {
    ctx.ui.notify(
      `Model '${orchestratorModel}' not found in registry`,
      "error",
    );
    return;
  }

  // Persist to settings.json for future sessions
  let settings: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf-8");
    settings = JSON.parse(raw);
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  settings.defaultProvider = provider;
  settings.defaultModel = model;
  await writeJson(SETTINGS_PATH, settings);

  // Apply immediately — no reload needed
  const success = await pi.setModel(modelObj);
  if (!success) {
    ctx.ui.notify(`No API key for '${orchestratorModel}'`, "error");
    return;
  }
  ctx.ui.notify(`Switched to ${orchestratorModel}`, "success");
}

// Helper to ask user for a string
async function promptInput(
  ctx: any,
  title: string,
  initialValue: string = "",
): Promise<string | null> {
  return await ctx.ui.custom(
    (tui: any, theme: any, _kb: any, done: any) => {
      const container = new Container() as any;
      container.focused = true;

      container.addChild(
        new DynamicBorder((s: string) => theme.fg("accent", s)),
      );
      container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

      const input = new Input();
      input.setValue(initialValue);
      input.onSubmit = (val) => done(val.trim());
      input.onEscape = () => done(null);
      input.focused = true;

      container.handleInput = (data: string) => {
        input.handleInput(data);
        tui.requestRender();
      };

      container.addChild(input);
      container.addChild(
        new DynamicBorder((s: string) => theme.fg("accent", s)),
      );

      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => container.handleInput(data),
      };
    },
    { overlay: true },
  );
}

function validateProfilePayload(parsed: any): Profile {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Payload is not an object");
  if (parsed._type !== "piprofile") throw new Error("Not a PiProfile payload");
  if (parsed.version !== 1)
    throw new Error(`Unsupported profile version: ${parsed.version}`);

  const p = parsed.profile;
  if (!p || typeof p !== "object" || Array.isArray(p))
    throw new Error("Missing profile object field");
  if (typeof p.name !== "string" || !p.name)
    throw new Error("Invalid or missing profile name");

  if (
    !p.orchestrator ||
    typeof p.orchestrator !== "object" ||
    Array.isArray(p.orchestrator)
  )
    throw new Error("Missing or invalid orchestrator");
  if (typeof p.orchestrator.model !== "string")
    throw new Error("Orchestrator model must be a string");
  if (typeof p.orchestrator.thinking !== "string")
    throw new Error("Orchestrator thinking must be a string");

  const agents: Record<string, { model: string; thinking: string }> = {};
  if (p.agents !== undefined) {
    if (
      typeof p.agents !== "object" ||
      p.agents === null ||
      Array.isArray(p.agents)
    )
      throw new Error("Agents must be an object");
    for (const key of Object.keys(p.agents)) {
      const val = p.agents[key];
      if (!val || typeof val !== "object" || Array.isArray(val))
        throw new Error(`Agent '${key}' config is invalid`);
      if (typeof val.model !== "string")
        throw new Error(`Agent '${key}' model must be a string`);
      if (typeof val.thinking !== "string")
        throw new Error(`Agent '${key}' thinking must be a string`);
      agents[key] = { model: val.model, thinking: val.thinking };
    }
  }

  if (p.favorite !== undefined && typeof p.favorite !== "boolean") {
    throw new Error("Favorite must be a boolean");
  }

  return {
    name: p.name,
    orchestrator: {
      model: p.orchestrator.model,
      thinking: p.orchestrator.thinking,
    },
    agents,
    favorite: p.favorite,
  };
}

export default function (pi: ExtensionAPI) {
  let activeProfile: string | undefined;

  pi.registerCommand("profiles", {
    description: "Manage SDD model profiles",
    handler: async (args, ctx) => {
      // Subcommand for save
      if (args[0] === "save") {
        const profileName = args[1];
        if (!profileName) {
          ctx.ui.notify(
            "Error: Provide a profile name (e.g. /profiles save my-profile)",
            "error",
          );
          return;
        }

        const models = await readJson(MODELS_PATH);
        const orchestrator = models["gentle-orchestrator"] || {
          model: "",
          thinking: "",
        };
        const agents: any = {};
        for (const key of Object.keys(models)) {
          if (key !== "gentle-orchestrator") {
            agents[key] = models[key];
          }
        }
        const profiles = await readJson(PROFILES_PATH);
        profiles[profileName] = { name: profileName, orchestrator, agents };
        await writeJson(PROFILES_PATH, profiles);
        ctx.ui.notify(`Profile '${profileName}' saved`, "info");
        return;
      }

      while (true) {
        const profiles: Record<string, Profile> = await readJson(PROFILES_PATH);
        const profileNames = Object.keys(profiles);

        const items = [
          {
            value: "__CREATE__",
            label: "✨ Create New Profile from Current Config",
            description: "Saves models.json into a new profile",
          },
          {
            value: "__IMPORT__",
            label: "📥 Import Profile from String",
            description: "Load a profile from a shared string",
          },
          ...profileNames.map((name) => ({
            value: name,
            label:
              name +
              (name === activeProfile ? " [▶ Active]" : "") +
              (profiles[name].favorite ? " [★ Favorite]" : ""),
            description: `Orchestrator: ${profiles[name].orchestrator?.model || "none"}`,
          })),
        ];

        // Pick Profile
        const selectedProfile = await ctx.ui.custom<string | null>(
          (tui, theme, _kb, done) => {
            const container = new Container();
            container.addChild(
              new DynamicBorder((s: string) => theme.fg("accent", s)),
            );
            container.addChild(
              new Text(
                theme.fg("accent", theme.bold("Profiles Manager")),
                1,
                0,
              ),
            );

            const list = new SelectList(items, Math.min(items.length, 10), {
              selectedPrefix: (t) => theme.fg("accent", t),
              selectedText: (t) => theme.fg("accent", t),
              description: (t) => theme.fg("muted", t),
              scrollInfo: (t) => theme.fg("dim", t),
              noMatch: (t) => theme.fg("warning", t),
            });
            list.onSelect = (item) => done(item.value);
            list.onCancel = () => done(null);
            container.addChild(list);

            container.addChild(
              new Text(
                theme.fg("dim", "↑↓ navigate • enter select • esc close"),
                1,
                0,
              ),
            );
            container.addChild(
              new DynamicBorder((s: string) => theme.fg("accent", s)),
            );

            return {
              render: (w) => container.render(w),
              invalidate: () => container.invalidate(),
              handleInput: (data) => {
                list.handleInput(data);
                tui.requestRender();
              },
            };
          },
          { overlay: true },
        );

        if (!selectedProfile) break;

        if (selectedProfile === "__IMPORT__") {
          const importStr = await promptInput(
            ctx,
            "Paste profile export string:",
            "",
          );
          if (importStr) {
            try {
              const str = importStr.trim();
              const prefix = "piprofile:1:";
              if (!str.startsWith(prefix)) {
                throw new Error("String must start with piprofile:1:");
              }
              const base64Part = str.slice(prefix.length);
              const decoded = Buffer.from(base64Part, "base64").toString(
                "utf-8",
              );
              const parsed = JSON.parse(decoded);

              const validProfile = validateProfilePayload(parsed);

              let newName = validProfile.name;
              while (profiles[newName]) {
                newName += "-imported";
              }
              validProfile.name = newName;
              profiles[newName] = validProfile;
              await writeJson(PROFILES_PATH, profiles);
              ctx.ui.notify(`Imported profile '${newName}'`, "info");
            } catch (e: any) {
              ctx.ui.notify(`Invalid profile string: ${e.message}`, "error");
            }
          }
          continue;
        }

        if (selectedProfile === "__CREATE__") {
          const newName = await promptInput(ctx, "Enter new profile name:");
          if (newName) {
            const models = await readJson(MODELS_PATH);
            const orchestrator = models["gentle-orchestrator"] || {
              model: "",
              thinking: "",
            };
            const agents: any = {};
            for (const key of Object.keys(models)) {
              if (key !== "gentle-orchestrator") {
                agents[key] = models[key];
              }
            }
            profiles[newName] = { name: newName, orchestrator, agents };
            await writeJson(PROFILES_PATH, profiles);
            ctx.ui.notify(`Created profile '${newName}'`, "info");
          }
          continue;
        }

        // Action menu for existing profile
        while (true) {
          const actionItems = [
            {
              value: "activate",
              label: "▶ Activate",
              description: "Apply this profile and switch main model",
            },
            {
              value: "favorite",
              label: "★ Set as Favorite",
              description: "Mark this profile as the session default",
            },
            {
              value: "edit",
              label: "✎ Edit",
              description: "Modify agents in this profile",
            },
            {
              value: "export",
              label: "📤 Export to String",
              description: "Share this profile as a string",
            },
            {
              value: "delete",
              label: "✖ Delete",
              description: "Remove this profile",
            },
            {
              value: "back",
              label: "← Back",
              description: "Return to profile list",
            },
          ];

          const selectedAction = await ctx.ui.custom<string | null>(
            (tui, theme, _kb, done) => {
              const container = new Container();
              container.addChild(
                new DynamicBorder((s: string) => theme.fg("accent", s)),
              );
              container.addChild(
                new Text(
                  theme.fg(
                    "accent",
                    theme.bold(`Profile: '${selectedProfile}'`),
                  ),
                  1,
                  0,
                ),
              );

              const list = new SelectList(actionItems, 4, {
                selectedPrefix: (t) => theme.fg("accent", t),
                selectedText: (t) => theme.fg("accent", t),
                description: (t) => theme.fg("muted", t),
                scrollInfo: (t) => theme.fg("dim", t),
                noMatch: (t) => theme.fg("warning", t),
              });
              list.onSelect = (item) => done(item.value);
              list.onCancel = () => done(null);
              container.addChild(list);
              container.addChild(
                new DynamicBorder((s: string) => theme.fg("accent", s)),
              );

              return {
                render: (w) => container.render(w),
                invalidate: () => container.invalidate(),
                handleInput: (data) => {
                  list.handleInput(data);
                  tui.requestRender();
                },
              };
            },
            { overlay: true },
          );

          if (!selectedAction || selectedAction === "back") {
            break;
          }

          if (selectedAction === "activate") {
            const profile = profiles[selectedProfile];
            await applyProfileModels(profile);

            // Apply orchestrator model as main model in real time
            if (profile.orchestrator?.model) {
              await applyMainModel(pi, ctx, profile.orchestrator.model);
            } else {
              ctx.ui.notify(
                `Activated profile '${selectedProfile}' (no orchestrator model).`,
                "info",
              );
            }
            activeProfile = selectedProfile;
            ctx.ui.setStatus(STATUS_KEY, selectedProfile);
            return;
          }

          if (selectedAction === "favorite") {
            for (const key of Object.keys(profiles)) {
              profiles[key].favorite = key === selectedProfile;
            }
            await writeJson(PROFILES_PATH, profiles);
            ctx.ui.notify(`Set '${selectedProfile}' as favorite.`, "info");
            break;
          }

          if (selectedAction === "export") {
            const currentProfile = profiles[selectedProfile];
            const payload = {
              _type: "piprofile",
              version: 1,
              profile: {
                name: currentProfile.name,
                orchestrator: currentProfile.orchestrator,
                agents: currentProfile.agents || {},
                favorite: currentProfile.favorite,
              },
            };
            const exportedStr =
              "piprofile:1:" +
              Buffer.from(JSON.stringify(payload)).toString("base64");
            await promptInput(
              ctx,
              `Copy this export string for '${selectedProfile}' (Esc/Enter to exit):`,
              exportedStr,
            );
            continue; // Keep action menu open
          }

          if (selectedAction === "delete") {
            delete profiles[selectedProfile];
            await writeJson(PROFILES_PATH, profiles);
            ctx.ui.notify(`Deleted profile '${selectedProfile}'.`, "info");
            break;
          }

          if (selectedAction === "edit") {
            // Edit Flow
            while (true) {
              const currentProfile = profiles[selectedProfile];
              const agentKeys = [
                "orchestrator",
                ...Object.keys(currentProfile.agents || {}),
              ];

              const editItems = agentKeys.map((k) => {
                const conf =
                  k === "orchestrator"
                    ? currentProfile.orchestrator
                    : currentProfile.agents[k];
                return {
                  value: k,
                  label: k,
                  description: `${conf?.model || "none"} (${conf?.thinking || "low"})`,
                };
              });
              editItems.push({
                value: "__ADD__",
                label: "➕ Add Subagent",
                description: "Add a specific configuration for a subagent",
              });
              editItems.push({
                value: "back",
                label: "← Back",
                description: "Return to profile menu",
              });

              const pickedAgent = await ctx.ui.custom<string | null>(
                (tui, theme, _kb, done) => {
                  const container = new Container();
                  container.addChild(
                    new DynamicBorder((s: string) => theme.fg("accent", s)),
                  );
                  container.addChild(
                    new Text(
                      theme.fg(
                        "accent",
                        theme.bold(`Edit Profile '${selectedProfile}'`),
                      ),
                      1,
                      0,
                    ),
                  );

                  const list = new SelectList(
                    editItems,
                    Math.min(editItems.length, 10),
                    {
                      selectedPrefix: (t) => theme.fg("accent", t),
                      selectedText: (t) => theme.fg("accent", t),
                      description: (t) => theme.fg("muted", t),
                      scrollInfo: (t) => theme.fg("dim", t),
                      noMatch: (t) => theme.fg("warning", t),
                    },
                  );
                  list.onSelect = (item) => done(item.value);
                  list.onCancel = () => done(null);
                  container.addChild(list);
                  container.addChild(
                    new DynamicBorder((s: string) => theme.fg("accent", s)),
                  );

                  return {
                    render: (w) => container.render(w),
                    invalidate: () => container.invalidate(),
                    handleInput: (data) => {
                      list.handleInput(data);
                      tui.requestRender();
                    },
                  };
                },
                { overlay: true },
              );

              if (!pickedAgent || pickedAgent === "back") break;

              let agentName = pickedAgent;
              // If adding, ask for agent name
              if (agentName === "__ADD__") {
                const newName = await promptInput(
                  ctx,
                  "Subagent Name (e.g. sdd-apply):",
                );
                if (!newName) continue;
                agentName = newName;
                if (!currentProfile.agents) currentProfile.agents = {};
                currentProfile.agents[agentName] = {
                  model: "omni/antigravity/gemini-3.6-flash-low",
                  thinking: "low",
                };
                await writeJson(PROFILES_PATH, profiles);
              }

              // Edit Agent
              while (true) {
                const conf =
                  agentName === "orchestrator"
                    ? currentProfile.orchestrator
                    : currentProfile.agents[agentName];

                const modifierItems = [
                  {
                    value: "model",
                    label: "Modify Model",
                    description: conf?.model || "none",
                  },
                  {
                    value: "thinking",
                    label: "Modify Thinking",
                    description: conf?.thinking || "low",
                  },
                  {
                    value: "delete",
                    label: "✖ Remove Agent from profile",
                    description: "Delete this configuration",
                  },
                  { value: "back", label: "← Back", description: "" },
                ];

                const pickedMod = await ctx.ui.custom<string | null>(
                  (tui, theme, _kb, done) => {
                    const container = new Container();
                    container.addChild(
                      new DynamicBorder((s: string) => theme.fg("accent", s)),
                    );
                    container.addChild(
                      new Text(
                        theme.fg(
                          "accent",
                          theme.bold(`Edit Agent '${agentName}'`),
                        ),
                        1,
                        0,
                      ),
                    );
                    const list = new SelectList(modifierItems, 4, {
                      selectedPrefix: (t) => theme.fg("accent", t),
                      selectedText: (t) => theme.fg("accent", t),
                      description: (t) => theme.fg("muted", t),
                      scrollInfo: (t) => theme.fg("dim", t),
                      noMatch: (t) => theme.fg("warning", t),
                    });
                    list.onSelect = (item) => done(item.value);
                    list.onCancel = () => done(null);
                    container.addChild(list);
                    container.addChild(
                      new DynamicBorder((s: string) => theme.fg("accent", s)),
                    );
                    return {
                      render: (w) => container.render(w),
                      invalidate: () => container.invalidate(),
                      handleInput: (data) => {
                        list.handleInput(data);
                        tui.requestRender();
                      },
                    };
                  },
                  { overlay: true },
                );

                if (!pickedMod || pickedMod === "back") break;

                if (pickedMod === "delete") {
                  if (agentName === "orchestrator") {
                    ctx.ui.notify("Cannot delete orchestrator", "error");
                  } else {
                    delete currentProfile.agents[agentName];
                    await writeJson(PROFILES_PATH, profiles);
                    ctx.ui.notify(`Removed ${agentName}`, "info");
                    break;
                  }
                } else if (pickedMod === "model") {
                  let availableModels: any[] = [];
                  try {
                    availableModels = await ctx.modelRegistry.getAvailable();
                  } catch {
                    // The custom identifier option remains available.
                  }
                  const modelItems = [
                    {
                      value: "back",
                      label: "← Back",
                      description: "Return to agent editing",
                    },
                    {
                      value: "__CUSTOM__",
                      label: "✎ Type custom model identifier...",
                      description: "Use if model is not in list",
                    },
                    ...availableModels
                      .map((model: any) => `${model.provider}/${model.id}`)
                      .sort((a: string, b: string) => a.localeCompare(b))
                      .map((model: string) => ({ value: model, label: model })),
                  ];
                  let newModel = await ctx.ui.custom<string | null>(
                    (tui, theme, kb, done) => {
                      const container = new Container();
                      const input = new Input();
                      input.focused = true;
                      const createList = (items: typeof modelItems) => {
                        const list = new SelectList(items, 12, {
                          selectedPrefix: (t) => theme.fg("accent", t),
                          selectedText: (t) => theme.fg("accent", t),
                          description: (t) => theme.fg("muted", t),
                          scrollInfo: (t) => theme.fg("dim", t),
                          noMatch: (t) => theme.fg("warning", t),
                        });
                        list.onSelect = (item) => done(item.value);
                        list.onCancel = () => done(null);
                        return list;
                      };
                      let list = createList(modelItems);
                      const renderContainer = () => {
                        container.clear();
                        container.addChild(
                          new DynamicBorder((s: string) =>
                            theme.fg("accent", s),
                          ),

                        );
                        container.addChild(
                          new Text(
                            theme.fg(
                              "accent",
                              theme.bold(`Select Model for ${agentName}`),
                            ),
                            1,
                            0,
                          ),
                        );
                        container.addChild(
                          new Text(
                            theme.fg(
                              "dim",
                              "Type to search • Enter to select • Esc to cancel",
                            ),
                            1,
                            0,
                          ),
                        );
                        container.addChild(input);
                        container.addChild(new Text("", 1, 0));
                        container.addChild(list);
                        container.addChild(
                          new DynamicBorder((s: string) =>
                            theme.fg("accent", s),
                          ),
                        );
                      };
                      renderContainer();
                      let lastValue = "";
                      return {
                        render: (width) => container.render(width),
                        invalidate: () => container.invalidate(),
                        handleInput: (data) => {
                          if (
                            kb.matches(data, "tui.select.up") ||
                            kb.matches(data, "tui.select.down") ||
                            kb.matches(data, "tui.select.confirm") ||
                            kb.matches(data, "tui.select.cancel")
                          ) {
                            list.handleInput(data);
                          } else {
                            input.handleInput(data);
                            const value = input.getValue();
                            if (value !== lastValue) {
                              lastValue = value;
                              const query = value.toLowerCase();
                              list = createList(
                                modelItems.filter(
                                  (item) =>
                                    item.value === "__CUSTOM__" ||
                                    item.value === "back" ||
                                    item.label.toLowerCase().includes(query),
                                ),
                              );
                              renderContainer();
                            }
                          }
                          tui.requestRender();
                        },
                      };
                    },
                    { overlay: true },
                  );
                  if (newModel === "back") {
                    continue;
                  }
                  if (newModel === "__CUSTOM__") {
                    newModel = await promptInput(
                      ctx,
                      `Custom model for ${agentName}:`,
                      conf.model,
                    );
                  }
                  if (newModel !== null) {
                    conf.model = newModel;
                    await writeJson(PROFILES_PATH, profiles);
                  }
                } else if (pickedMod === "thinking") {
                  const thinkingLevels = [
                    "low",
                    "medium",
                    "high",
                    "xhigh",
                    "max",
                  ].map((t) => ({ value: t, label: t }));
                  const newThinking = await ctx.ui.custom<string | null>(
                    (tui, theme, _kb, done) => {
                      const container = new Container();
                      container.addChild(
                        new DynamicBorder((s: string) => theme.fg("accent", s)),
                      );
                      container.addChild(
                        new Text(
                          theme.fg(
                            "accent",
                            theme.bold(`Thinking for ${agentName}`),
                          ),
                          1,
                          0,
                        ),
                      );
                      const list = new SelectList(thinkingLevels, 5, {
                        selectedPrefix: (t) => theme.fg("accent", t),
                        selectedText: (t) => theme.fg("accent", t),
                        description: (t) => theme.fg("muted", t),
                        scrollInfo: (t) => theme.fg("dim", t),
                        noMatch: (t) => theme.fg("warning", t),
                      });
                      list.onSelect = (item) => done(item.value);
                      list.onCancel = () => done(null);
                      container.addChild(list);
                      container.addChild(
                        new DynamicBorder((s: string) => theme.fg("accent", s)),
                      );
                      return {
                        render: (w) => container.render(w),
                        invalidate: () => container.invalidate(),
                        handleInput: (data) => {
                          list.handleInput(data);
                          tui.requestRender();
                        },
                      };
                    },
                    { overlay: true },
                  );

                  if (newThinking) {
                    conf.thinking = newThinking;
                    await writeJson(PROFILES_PATH, profiles);
                  }
                }
              }
            }
          }
        }
      }
    },
  });

  // --- Shortcut Registration ---
  const shortcutHandler = {
    description: "Cycle agent profile",
    async handler(ctx: any) {
      try {
        const profiles: Record<string, Profile> = await readJson(PROFILES_PATH);
        const names = Object.keys(profiles);
        if (!names.length)
          return ctx.ui.notify("No profiles configured", "error");
        const idx = names.indexOf(activeProfile ?? "");
        const next = names[(idx + 1 + names.length) % names.length];
        const profile = profiles[next];
        await applyProfileModels(profile);
        if (profile?.orchestrator?.model) {
          await applyMainModel(pi, ctx, profile.orchestrator.model);
        }
        activeProfile = next;
        ctx.ui.setStatus(STATUS_KEY, next);
        ctx.ui.notify(`Switched to profile: ${next}`, "info");
      } catch (error: unknown) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  };
  // Register ctrl+shift+p as the profile cycling shortcut
  if (supportedShortcut("ctrl+shift+p")) {
    try {
      pi.registerShortcut("ctrl+shift+p" as any, shortcutHandler);
    } catch {
      // Shortcut unavailable, continue without it
    }
  }

  // --- Lifecycle Hooks ---
  pi.on("session_start", async (_event: unknown, ctx: any) => {
    try {
      const profiles: Record<string, Profile> = await readJson(PROFILES_PATH);
      const names = Object.keys(profiles);
      if (!names.length) return;

      const favoriteName = Object.keys(profiles).find(
        (n) => profiles[n].favorite,
      );
      if (favoriteName) {
        const profile = profiles[favoriteName];
        await applyProfileModels(profile);
        if (profile.orchestrator?.model) {
          await applyMainModel(pi, ctx, profile.orchestrator.model);
        }
        activeProfile = favoriteName;
        ctx.ui.setStatus(STATUS_KEY, favoriteName);
      } else {
        // Fallback: Infer the active profile from the current models.json
        const currentModels = await readJson(MODELS_PATH);
        const currentOrch = currentModels["gentle-orchestrator"]?.model;
        if (currentOrch) {
          const matchedName = names.find(
            (n) => profiles[n].orchestrator?.model === currentOrch,
          );
          if (matchedName) {
            activeProfile = matchedName;
            ctx.ui.setStatus(STATUS_KEY, matchedName);
          }
        }
      }
    } catch {
      // Graceful degradation
    }
  });

  pi.on("session_shutdown", async (_event: unknown, ctx: any) => {
    try {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // Graceful degradation
    }
  });
}
