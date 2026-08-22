import { normalizeAgent, resolveDefaultRoute } from "./config.js";
import { STATUS_KEY } from "./constants.js";
import { SessionState } from "./session-state.js";
import type {
  ActiveSnapshot,
  Config,
  ContextLike,
  PersistedRoute,
  PiLike,
  Route,
  RuntimeEffort,
} from "./types.js";

export class ProfileManager {
  readonly state = new SessionState();
  config: Config = { version: 1, profiles: {} };
  private ctx?: ContextLike;

  constructor(
    readonly pi: PiLike,
    ctx?: ContextLike,
  ) {
    this.ctx = ctx;
  }

  setContext(ctx: ContextLike) {
    this.ctx = ctx;
  }

  setConfig(config: Config) {
    this.config = config;
  }

  private context(): ContextLike {
    if (!this.ctx) throw new Error("No active Pi context");
    return this.ctx;
  }

  names(): string[] {
    const ordered = Object.entries(this.config.profiles)
      .sort((a, b) => a[1].order - b[1].order)
      .map(([name]) => name);
    return this.config.cycle?.length ? this.config.cycle : ordered;
  }

  private target(route: PersistedRoute | undefined, baseline: Route): Route {
    const model = route?.model ?? baseline.model;
    // "inherit" sentinel means: do not change the current thinking level
    const effort =
      route?.effort !== undefined
        ? route.effort !== "inherit"
          ? (route.effort as RuntimeEffort)
          : undefined
        : baseline.effort;
    return {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    };
  }

  private async apply(ctx: ContextLike, target: Route): Promise<void> {
    if (target.model) {
      const model = ctx.modelRegistry.find(
        target.model.provider,
        target.model.id,
      );
      if (!model) {
        throw new Error(
          `model ${target.model.provider}/${target.model.id} is unavailable`,
        );
      }
      if (!(await this.pi.setModel(model))) {
        throw new Error(
          `No API key for ${target.model.provider}/${target.model.id}`,
        );
      }
    }
    if (target.effort !== undefined) {
      try {
        this.pi.setThinkingLevel(target.effort);
      } catch {
        // Graceful degradation: effort not applied live
      }
    }
  }

  async use(name: string): Promise<ActiveSnapshot> {
    const ctx = this.context();
    const profile = this.config.profiles[name];
    if (!profile) throw new Error(`Unknown profile: ${name}`);

    const current = this.state.get(ctx.sessionManager.getSessionId());
    const baseline: Route = current?.baseline ?? {
      ...(ctx.model
        ? { model: { provider: ctx.model.provider, id: ctx.model.id } }
        : {}),
      effort: this.pi.getThinkingLevel(),
    };
    const target = this.target(profile.orchestrator, baseline);

    try {
      await this.apply(ctx, target);
      const snapshot: ActiveSnapshot = {
        profile: name,
        route: resolveDefaultRoute(profile.orchestrator),
        baseline,
        activatedAt: new Date().toISOString(),
      };
      this.state.activate(this.pi, ctx, snapshot);
      ctx.ui.setStatus(STATUS_KEY, name);
      return snapshot;
    } catch (error) {
      // Rollback: restore previous route
      if (current) {
        try {
          await this.apply(ctx, this.target(current.route, current.baseline));
        } catch {
          /* retain the original error */
        }
      } else {
        try {
          await this.apply(ctx, baseline);
        } catch {
          /* retain the original error */
        }
      }
      throw error;
    }
  }

  async off(): Promise<void> {
    const ctx = this.context();
    const active = this.state.get(ctx.sessionManager.getSessionId());
    if (!active) return;

    await this.apply(ctx, active.baseline);
    this.state.deactivate(this.pi, ctx);
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  async next(): Promise<ActiveSnapshot> {
    const names = this.names();
    if (!names.length) throw new Error("No profiles configured");

    const current = this.state.get(
      this.context().sessionManager.getSessionId(),
    )?.profile;
    return this.use(
      names[(names.indexOf(current ?? "") + 1 + names.length) % names.length],
    );
  }

  resolveAgentRoute(agent: string, sessionId: string): Route | undefined {
    const active = this.state.get(sessionId);
    if (!active) return undefined;
    // Per-agent routing deferred — return undefined for now
    return undefined;
  }
}
