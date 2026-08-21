import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { ExtensionAPI, TUIContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, Input } from "@earendil-works/pi-tui";

const GENTLE_DIR = path.join(os.homedir(), ".pi", "gentle-ai");
const MODELS_PATH = path.join(GENTLE_DIR, "models.json");
const PROFILES_PATH = path.join(GENTLE_DIR, "sdd-profiles-manager.json");
const AGENT_HOME = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const SUBAGENTS_PATH = path.join(AGENT_HOME, "subagents.json");

type AgentConfig = {
  model?: string;
  thinking?: string;
  [key: string]: unknown;
};

interface Profile {
  name: string;
  orchestrator: AgentConfig;
  agents: Record<string, AgentConfig>;
}

const ORCHESTRATOR_NAME = "gentle-orchestrator";
const DEFAULT_AGENT_CONFIG: AgentConfig = { model: "", thinking: "" };

async function discoverAgentNames(cwd: string): Promise<string[]> {
  const agentHome = process.env.GENTLE_PI_AGENT_HOME || path.join(os.homedir(), ".pi", "agent");
  const directories = [
    path.join(agentHome, "agents"),
    path.join(agentHome, "subagents"),
    path.join(os.homedir(), ".agents"),
    path.join(cwd, ".agents"),
    path.join(cwd, ".pi", "agents"),
    path.join(cwd, ".pi", "subagents"),
  ];
  const names = new Set<string>();

  for (const directory of directories) {
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          names.add(entry.name.slice(0, -3));
        }
      }
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  return [...names].filter((name) => name !== ORCHESTRATOR_NAME).sort();
}

async function allAgentNames(cwd: string, ...configs: Array<Record<string, AgentConfig> | undefined>): Promise<string[]> {
  const names = new Set(await discoverAgentNames(cwd));
  for (const config of configs) {
    for (const name of Object.keys(config || {})) {
      if (name !== ORCHESTRATOR_NAME) names.add(name);
    }
  }
  return [...names].sort();
}

async function profileFromModels(cwd: string, name: string, models: Record<string, AgentConfig>): Promise<Profile> {
  const agents: Record<string, AgentConfig> = {};
  for (const key of await allAgentNames(cwd, models)) {
    agents[key] = models[key] || { ...DEFAULT_AGENT_CONFIG };
  }
  return {
    name,
    orchestrator: models[ORCHESTRATOR_NAME] || { ...DEFAULT_AGENT_CONFIG },
    agents,
  };
}

function sameAgentConfig(left: AgentConfig | undefined, right: AgentConfig | undefined): boolean {
  return (left?.model || "") === (right?.model || "")
    && (left?.thinking || "") === (right?.thinking || "");
}

async function profileIsActive(cwd: string, profile: Profile, models: Record<string, AgentConfig>): Promise<boolean> {
  if (!sameAgentConfig(profile.orchestrator, models[ORCHESTRATOR_NAME])) return false;
  for (const name of await allAgentNames(cwd, models, profile.agents)) {
    const activeConfig = models[name] || DEFAULT_AGENT_CONFIG;
    const profileConfig = profile.agents?.[name] || activeConfig;
    if (!sameAgentConfig(profileConfig, activeConfig)) return false;
  }
  return true;
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

async function syncSubagentsJson(models: Record<string, AgentConfig>): Promise<void> {
  let subagents: Record<string, unknown> = {};
  try {
        const raw = await fs.readFile(SUBAGENTS_PATH, "utf-8");
        subagents = JSON.parse(raw);
  } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
  }

  const modelProfiles: Record<string, { model?: string; effort?: string }> = {};
  for (const [name, config] of Object.entries(models)) {
        if (name === ORCHESTRATOR_NAME) continue;
        const profile: Record<string, string> = {};
        if (config.model) profile.model = config.model;
        if (config.thinking) profile.effort = config.thinking;
        if (Object.keys(profile).length > 0) modelProfiles[name] = profile;
  }

  if (Object.keys(modelProfiles).length > 0) {
        subagents.model_profiles = modelProfiles;
  } else {
        delete subagents.model_profiles;
  }

  await writeJson(SUBAGENTS_PATH, subagents);
}

// Helper to ask user for a string
async function promptInput(ctx: any, title: string, initialValue: string = ""): Promise<string | null> {
  return await ctx.ui.custom<string | null>((tui: any, theme: any, _kb: any, done: any) => {
    const container = new Container() as any;
    container.focused = true; // Make container focusable

    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

    const input = new Input();
    input.setValue(initialValue);
    input.onSubmit = (val) => done(val.trim());
    input.onEscape = () => done(null);
    input.focused = true;

    // Wire up focus propagation
    container.handleInput = (data: string) => {
      input.handleInput(data);
      tui.requestRender();
    };

    container.addChild(input);
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => container.handleInput(data),
    };
  }, { overlay: true });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("profiles", {
    description: "Manage SDD model profiles",
    handler: async (args, ctx) => {
      // Subcommand for save
      if (args[0] === "save") {
        const profileName = args[1];
        if (!profileName) {
          ctx.ui.notify("Error: Provide a profile name (e.g. /profiles save my-profile)", "error");
          return;
        }

        const models = await readJson(MODELS_PATH);
        const profiles = await readJson(PROFILES_PATH);
        profiles[profileName] = await profileFromModels(ctx.cwd, profileName, models);
        await writeJson(PROFILES_PATH, profiles);
        ctx.ui.notify(`Profile '${profileName}' saved`, "success");
        return;
      }

      while (true) {
            let profiles: Record<string, Profile> = await readJson(PROFILES_PATH);
            const models = await readJson(MODELS_PATH);
            const profileNames = Object.keys(profiles);
            const activeProfiles = new Set(
              (await Promise.all(profileNames.map(async (name) =>
                (await profileIsActive(ctx.cwd, profiles[name], models)) ? name : null
              ))).filter((name): name is string => name !== null),
            );

            const items = [
              { value: "__CREATE__", label: "✨ Create New Profile from Current Config", description: "Saves models.json into a new profile" },
              { value: "__IMPORT__", label: "📥 Import Profile from String", description: "Restore a profile shared by you or a teammate" },
              ...profileNames.map((name) => ({
                value: name,
                label: activeProfiles.has(name) ? `✓ ${name}` : name,
                description: activeProfiles.has(name)
                  ? `Active profile · Orchestrator: ${profiles[name].orchestrator?.model || "none"}`
                  : `Orchestrator: ${profiles[name].orchestrator?.model || "none"}`,
              }))
            ];

        // Pick Profile
        const selectedProfile = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
          const container = new Container();
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          container.addChild(new Text(theme.fg("accent", theme.bold("Profiles Manager")), 1, 0));

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

          container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc close"), 1, 0));
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

          return {
            render: (w) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data) => { list.handleInput(data); tui.requestRender(); },
          };
        }, { overlay: true });

        if (!selectedProfile) break; // Finished and exit loop

        if (selectedProfile === "__CREATE__") {
          const newName = await promptInput(ctx, "Enter new profile name:");
          if (newName) {
            const models = await readJson(MODELS_PATH);
            profiles[newName] = await profileFromModels(ctx.cwd, newName, models);
            await writeJson(PROFILES_PATH, profiles);
            ctx.ui.notify(`Created profile '${newName}'`, "success");
          }
          continue;
        }

        if (selectedProfile === "__IMPORT__") {
          const b64 = await promptInput(ctx, "Paste base64 profile string:");
          if (b64) {
            try {
              const decoded = Buffer.from(b64, "base64").toString("utf-8");
              const profileData = JSON.parse(decoded);
              if (!profileData.name || !profileData.orchestrator) throw new Error("Invalid structure");
              let finalName = profileData.name;
              let attempt = 1;
              while (profiles[finalName]) {
                finalName = `${profileData.name} (${attempt})`;
                attempt++;
              }
              profileData.name = finalName;
              profiles[finalName] = profileData;
              await writeJson(PROFILES_PATH, profiles);
              ctx.ui.notify(`Imported profile '${finalName}'`, "success");
            } catch (e) {
              ctx.ui.notify("Invalid profile string or format", "error");
            }
          }
          continue;
        }

        // Action menu for existing profile
        while (true) {
          const actionItems = [
            { value: "activate", label: "▶ Activate", description: "Apply this profile to models.json" },
            { value: "edit", label: "✎ Edit", description: "Modify agents in this profile" },
            { value: "export", label: "📤 Export", description: "Get base64 string to share this profile" },
            { value: "delete", label: "✖ Delete", description: "Remove this profile" },
            { value: "back", label: "← Back", description: "Return to profile list" },
          ];

          const selectedAction = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
            const container = new Container();
            container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
            container.addChild(new Text(theme.fg("accent", theme.bold(`Profile: '${selectedProfile}'`)), 1, 0));

            const list = new SelectList(actionItems, 5, {
              selectedPrefix: (t) => theme.fg("accent", t),
              selectedText: (t) => theme.fg("accent", t),
              description: (t) => theme.fg("muted", t),
              scrollInfo: (t) => theme.fg("dim", t),
              noMatch: (t) => theme.fg("warning", t),
            });
            list.onSelect = (item) => done(item.value);
            list.onCancel = () => done(null);
            container.addChild(list);
            container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

            return {
              render: (w) => container.render(w),
              invalidate: () => container.invalidate(),
              handleInput: (data) => { list.handleInput(data); tui.requestRender(); },
            };
          }, { overlay: true });

          if (!selectedAction || selectedAction === "back") {
            break; // Back to profile list
          }

          if (selectedAction === "activate") {
            const profile = profiles[selectedProfile];
            const currentModels = await readJson(MODELS_PATH);
            const newModels: Record<string, AgentConfig> = {};
            if (profile.orchestrator) {
              newModels[ORCHESTRATOR_NAME] = profile.orchestrator;
            }
            for (const key of await allAgentNames(ctx.cwd, currentModels, profile.agents)) {
              newModels[key] = profile.agents?.[key] || currentModels[key] || { ...DEFAULT_AGENT_CONFIG };
            }
            await writeJson(MODELS_PATH, newModels);
            await syncSubagentsJson(newModels);
            ctx.ui.notify(`Activated profile '${selectedProfile}'. Run /reload if needed.`, "success");
            break; // Back to profile list after activating
          }

          if (selectedAction === "export") {
            const b64 = Buffer.from(JSON.stringify(profiles[selectedProfile])).toString("base64");

            // OSC 52 sequence to push directly to system clipboard
            const osc52 = `\x1b]52;c;${Buffer.from(b64).toString("base64")}\x07`;
            process.stdout.write(osc52);

            await ctx.ui.custom((tui, theme, _kb, done) => {
              const container = new Container();
              container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
              container.addChild(new Text(theme.fg("accent", theme.bold("Profile Export")), 1, 0));
              container.addChild(new Text(theme.fg("status", "Sent to clipboard! (If it failed, select & copy the block below manually)"), 1, 0));
              container.addChild(new Text("", 1, 0));

              // Wrapping the base64 string manually so standard terminal selection copies it without newlines
              for (let i = 0; i < b64.length; i += 60) {
                 container.addChild(new Text(b64.slice(i, i + 60), 1, 0));
              }

              container.addChild(new Text("", 1, 0));
              container.addChild(new Text(theme.fg("dim", "Press Esc or Enter to return"), 1, 0));
              container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

              return {
                render: (w) => container.render(w),
                invalidate: () => container.invalidate(),
                handleInput: (data) => {
                  if (_kb.matches(data, "tui.select.cancel") || _kb.matches(data, "tui.select.confirm")) {
                    done(null);
                  }
                }
              };
            }, { overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 72, maxHeight: "85%" } });

            continue;
          }

          if (selectedAction === "delete") {
            delete profiles[selectedProfile];
            await writeJson(PROFILES_PATH, profiles);
            ctx.ui.notify(`Deleted profile '${selectedProfile}'.`, "success");
            break; // Back to profile list after deleting
          }

          if (selectedAction === "edit") {
            // Deep copy profile to allow canceling edits
            const currentProfile = JSON.parse(JSON.stringify(profiles[selectedProfile]));

            // Edit Flow
            while (true) {
                  const currentModels = await readJson(MODELS_PATH);
                  const agentNames = await allAgentNames(ctx.cwd, currentModels, currentProfile.agents);
                  if (!currentProfile.agents) currentProfile.agents = {};
                  for (const name of agentNames) {
                    currentProfile.agents[name] = currentProfile.agents[name] || currentModels[name] || { ...DEFAULT_AGENT_CONFIG };
                  }
                  const agentKeys = ["orchestrator", ...agentNames];

                  const editItems = agentKeys.map(k => {
                const conf = k === "orchestrator" ? currentProfile.orchestrator : currentProfile.agents[k];
                return {
                  value: k,
                  label: k,
                  description: `${conf?.model || "none"} (${conf?.thinking || "none"})`
                };
              });
              editItems.unshift({ value: "__BULK_THINKING__", label: "📦 Set All Thinking", description: "Apply the same thinking level to all agents" });
              editItems.unshift({ value: "__BULK_MODEL__", label: "📦 Set All Models", description: "Apply the same model to all agents" });
              editItems.unshift({ value: "__SAVE__", label: "💾 Save Changes", description: "Save all modifications to disk" });

              editItems.push({ value: "__ADD__", label: "➕ Add Subagent", description: "Add a specific configuration for a subagent" });
              editItems.push({ value: "back", label: "← Cancel", description: "Return WITHOUT saving" });

              const pickedAgent = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
                const container = new Container();
                container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
                container.addChild(new Text(theme.fg("accent", theme.bold(`Edit Profile '${selectedProfile}'`)), 1, 0));

                const list = new SelectList(editItems, Math.min(editItems.length, 10), {
                  selectedPrefix: (t) => theme.fg("accent", t),
                  selectedText: (t) => theme.fg("accent", t),
                  description: (t) => theme.fg("muted", t),
                  scrollInfo: (t) => theme.fg("dim", t),
                  noMatch: (t) => theme.fg("warning", t),
                });
                list.onSelect = (item) => done(item.value);
                list.onCancel = () => done(null);
                container.addChild(list);
                container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

                return {
                  render: (w) => container.render(w),
                  invalidate: () => container.invalidate(),
                  handleInput: (data) => { list.handleInput(data); tui.requestRender(); },
                };
              }, { overlay: true });

              if (!pickedAgent || pickedAgent === "back") {
                ctx.ui.notify("Discarded unsaved changes", "info");
                break;
              }

              if (pickedAgent === "__SAVE__") {
                profiles[selectedProfile] = currentProfile;
                await writeJson(PROFILES_PATH, profiles);
                ctx.ui.notify(`Saved changes to '${selectedProfile}'`, "success");
                break;
              }

              let agentName = pickedAgent;
              // If adding, ask for agent name
              if (agentName === "__ADD__") {
                const newName = await promptInput(ctx, "Subagent Name (e.g. sdd-apply):");
                if (!newName) continue;
                agentName = newName;
                if (!currentProfile.agents) currentProfile.agents = {};
                const currentModels = await readJson(MODELS_PATH);
                currentProfile.agents[agentName] = currentModels[agentName] || { ...DEFAULT_AGENT_CONFIG };
                continue; // go back to list to edit it
              }

              let bulkMode = false;
              if (agentName === "__BULK_MODEL__" || agentName === "__BULK_THINKING__") {
                bulkMode = true;
                agentName = "ALL AGENTS";
              }

              // Edit Agent
              while (true) {
                const conf = agentName === "orchestrator" ? currentProfile.orchestrator : currentProfile.agents[agentName];

                let modifierItems;
                if (bulkMode) {
                  modifierItems = [
                    pickedAgent === "__BULK_MODEL__" ? { value: "model", label: "Set Model for ALL", description: "Apply to all agents" } : { value: "thinking", label: "Set Thinking for ALL", description: "Apply to all agents" },
                    { value: "back", label: "← Back", description: "" },
                  ];
                } else {
                  modifierItems = [
                    { value: "model", label: "Modify Model", description: conf?.model || "none" },
                    { value: "thinking", label: "Modify Thinking", description: conf?.thinking || "none" },
                    { value: "delete", label: "✖ Remove Agent from profile", description: "Delete this configuration" },
                    { value: "back", label: "← Back", description: "" },
                  ];
                }

                const pickedMod = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
                  const container = new Container();
                  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
                  container.addChild(new Text(theme.fg("accent", theme.bold(`Edit Agent '${agentName}'`)), 1, 0));
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
                  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
                  return {
                    render: (w) => container.render(w),
                    invalidate: () => container.invalidate(),
                    handleInput: (data) => { list.handleInput(data); tui.requestRender(); },
                  };
                }, { overlay: true });

                if (!pickedMod || pickedMod === "back") break;

                if (pickedMod === "delete") {
                  if (agentName === "orchestrator") {
                    ctx.ui.notify("Cannot delete orchestrator", "error");
                  } else {
                    delete currentProfile.agents[agentName];
                    ctx.ui.notify(`Removed ${agentName}`, "info");
                    break;
                  }
                } else if (pickedMod === "model") {
                  let availableModels: any[] = [];
                  try {
                    availableModels = await (ctx as any).modelRegistry.getAvailable();
                  } catch (e) {
                    // Ignore, fallback handled
                  }
                  const modelStrings = availableModels
                    .map((m: any) => `${m.provider}/${m.id}`)
                    .sort((a: string, b: string) => a.localeCompare(b));

                  const modelItems = [
                    { value: "__CUSTOM__", label: "✎ Type custom model identifier...", description: "Use if model is not in list" },
                    ...modelStrings.map((m: string) => ({ value: m, label: m }))
                  ];

                  let newModel = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
                    const container = new Container();
                    const input = new Input();
                    input.focused = true;

                    const createList = (items: any[]) => {
                      const newList = new SelectList(items, 12, {
                        selectedPrefix: (t) => theme.fg("accent", t),
                        selectedText: (t) => theme.fg("accent", t),
                        description: (t) => theme.fg("muted", t),
                        scrollInfo: (t) => theme.fg("dim", t),
                        noMatch: (t) => theme.fg("warning", t),
                      });
                      newList.onSelect = (item) => done(item.value);
                      newList.onCancel = () => done(null);
                      return newList;
                    };

                    let list = createList(modelItems);

                    const renderContainer = () => {
                      container.clear();
                      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
                      container.addChild(new Text(theme.fg("accent", theme.bold(`Select Model for ${agentName}`)), 1, 0));
                      container.addChild(new Text(theme.fg("dim", "Type to search • Enter to select • Esc to cancel"), 1, 0));
                      container.addChild(input);
                      container.addChild(new Text("", 1, 0)); // Empty line between input and list
                      container.addChild(list);
                      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
                    };
                    renderContainer();

                    let lastVal = "";
                    return {
                      render: (w) => container.render(w),
                      invalidate: () => container.invalidate(),
                      handleInput: (data) => {
                        if (_kb.matches(data, "tui.select.up") ||
                            _kb.matches(data, "tui.select.down") ||
                            _kb.matches(data, "tui.select.confirm") ||
                            _kb.matches(data, "tui.select.cancel")) {
                          list.handleInput(data);
                        } else {
                          input.handleInput(data);
                          const val = input.getValue();
                          if (val !== lastVal) {
                            lastVal = val;
                            const query = val.toLowerCase();
                            const matches = modelItems.filter(item =>
                              item.value === "__CUSTOM__" || item.label.toLowerCase().includes(query)
                            );
                            list = createList(matches);
                            renderContainer();
                          }
                        }
                        tui.requestRender();
                      },
                    };
                  }, { overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 72, maxHeight: "85%" } });

                  if (newModel === "__CUSTOM__") {
                    newModel = await promptInput(ctx, `Custom model for ${agentName}:`, conf.model);
                  }

                  if (newModel !== null) {
                    if (bulkMode) {
                      currentProfile.orchestrator.model = newModel;
                      for (const k of Object.keys(currentProfile.agents)) currentProfile.agents[k].model = newModel;
                      break;
                    } else {
                      conf.model = newModel;
                    }
                  }
                } else if (pickedMod === "thinking") {
                  const thinkingLevels = ["none", "low", "medium", "high", "xhigh", "max"].map(t => ({ value: t, label: t }));
                  const newThinking = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
                    const container = new Container();
                    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
                    container.addChild(new Text(theme.fg("accent", theme.bold(`Thinking for ${agentName}`)), 1, 0));
                    const list = new SelectList(thinkingLevels, 6, {
                      selectedPrefix: (t) => theme.fg("accent", t),
                      selectedText: (t) => theme.fg("accent", t),
                      description: (t) => theme.fg("muted", t),
                      scrollInfo: (t) => theme.fg("dim", t),
                      noMatch: (t) => theme.fg("warning", t),
                    });
                    list.onSelect = (item) => done(item.value);
                    list.onCancel = () => done(null);
                    container.addChild(list);
                    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
                    return {
                      render: (w) => container.render(w),
                      invalidate: () => container.invalidate(),
                      handleInput: (data) => { list.handleInput(data); tui.requestRender(); },
                    };
                  }, { overlay: true });

                  if (newThinking) {
                    const applyThink = (c: any) => {
                      if (newThinking === "none") delete c.thinking;
                      else c.thinking = newThinking;
                    };
                    if (bulkMode) {
                      applyThink(currentProfile.orchestrator);
                      for (const k of Object.keys(currentProfile.agents)) applyThink(currentProfile.agents[k]);
                      break;
                    } else {
                      applyThink(conf);
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
  });
}
