import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { ExtensionAPI, TUIContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, Input } from "@earendil-works/pi-tui";

const GENTLE_DIR = path.join(os.homedir(), ".pi", "gentle-ai");
const MODELS_PATH = path.join(GENTLE_DIR, "models.json");
const PROFILES_PATH = path.join(GENTLE_DIR, "sdd-profiles-manager.json");

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
        const profileNames = Object.keys(profiles);
        
        const items = [
          { value: "__CREATE__", label: "✨ Create New Profile from Current Config", description: "Saves models.json into a new profile" },
          ...profileNames.map((name) => ({
            value: name,
            label: name,
            description: `Orchestrator: ${profiles[name].orchestrator?.model || "none"}`,
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

        // Action menu for existing profile
        while (true) {
          const actionItems = [
            { value: "activate", label: "▶ Activate", description: "Apply this profile to models.json" },
            { value: "edit", label: "✎ Edit", description: "Modify agents in this profile" },
            { value: "delete", label: "✖ Delete", description: "Remove this profile" },
            { value: "back", label: "← Back", description: "Return to profile list" },
          ];

          const selectedAction = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
            const container = new Container();
            container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
            container.addChild(new Text(theme.fg("accent", theme.bold(`Profile: '${selectedProfile}'`)), 1, 0));

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
            ctx.ui.notify(`Activated profile '${selectedProfile}'. Run /reload if needed.`, "success");
            break; // Back to profile list after activating
          } 
          
          if (selectedAction === "delete") {
            delete profiles[selectedProfile];
            await writeJson(PROFILES_PATH, profiles);
            ctx.ui.notify(`Deleted profile '${selectedProfile}'.`, "success");
            break; // Back to profile list after deleting
          }
          
          if (selectedAction === "edit") {
            // Edit Flow
            while (true) {
                  const currentProfile = profiles[selectedProfile];
                  const currentModels = await readJson(MODELS_PATH);
                  const agentNames = await allAgentNames(ctx.cwd, currentModels, currentProfile.agents);
                  if (!currentProfile.agents) currentProfile.agents = {};
                  for (const name of agentNames) {
                    currentProfile.agents[name] = currentProfile.agents[name] || currentModels[name] || { ...DEFAULT_AGENT_CONFIG };
                  }
                  await writeJson(PROFILES_PATH, profiles);
                  const agentKeys = ["orchestrator", ...agentNames];

                  const editItems = agentKeys.map(k => {
                const conf = k === "orchestrator" ? currentProfile.orchestrator : currentProfile.agents[k];
                return {
                  value: k,
                  label: k,
                  description: `${conf?.model || "none"} (${conf?.thinking || "low"})`
                };
              });
              editItems.push({ value: "__ADD__", label: "➕ Add Subagent", description: "Add a specific configuration for a subagent" });
              editItems.push({ value: "back", label: "← Back", description: "Return to profile menu" });

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

              if (!pickedAgent || pickedAgent === "back") break;

              let agentName = pickedAgent;
              // If adding, ask for agent name
              if (agentName === "__ADD__") {
                const newName = await promptInput(ctx, "Subagent Name (e.g. sdd-apply):");
                if (!newName) continue;
                agentName = newName;
                if (!currentProfile.agents) currentProfile.agents = {};
                const currentModels = await readJson(MODELS_PATH);
                currentProfile.agents[agentName] = currentModels[agentName] || { ...DEFAULT_AGENT_CONFIG };
                await writeJson(PROFILES_PATH, profiles);
              }

              // Edit Agent
              while (true) {
                const conf = agentName === "orchestrator" ? currentProfile.orchestrator : currentProfile.agents[agentName];
                
                const modifierItems = [
                  { value: "model", label: "Modify Model", description: conf?.model || "none" },
                  { value: "thinking", label: "Modify Thinking", description: conf?.thinking || "low" },
                  { value: "delete", label: "✖ Remove Agent from profile", description: "Delete this configuration" },
                  { value: "back", label: "← Back", description: "" },
                ];

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
                    await writeJson(PROFILES_PATH, profiles);
                    ctx.ui.notify(`Removed ${agentName}`, "success");
                    break;
                  }
                } else if (pickedMod === "model") {
                  const newModel = await promptInput(ctx, `Model for ${agentName}:`, conf.model);
                  if (newModel !== null) {
                    conf.model = newModel;
                    await writeJson(PROFILES_PATH, profiles);
                  }
                } else if (pickedMod === "thinking") {
                  const thinkingLevels = ["low", "medium", "high", "xhigh", "max"].map(t => ({ value: t, label: t }));
                  const newThinking = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
                    const container = new Container();
                    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
                    container.addChild(new Text(theme.fg("accent", theme.bold(`Thinking for ${agentName}`)), 1, 0));
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
                    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
                    return {
                      render: (w) => container.render(w),
                      invalidate: () => container.invalidate(),
                      handleInput: (data) => { list.handleInput(data); tui.requestRender(); },
                    };
                  }, { overlay: true });

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
}
