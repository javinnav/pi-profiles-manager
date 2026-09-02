import { isAbsolute, resolve } from "node:path";
import { ACTIVE_ENTRY_TYPE } from "./constants.js";
import type { ActiveSnapshot, ContextLike, PiLike, Route } from "./types.js";

type Marker = ActiveSnapshot | { off: true; cwd?: string };

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function validRoute(value: unknown): value is Route {
  return (
    object(value) &&
    Object.keys(value).every((key) => key === "model" || key === "effort") &&
    (value.model === undefined ||
      (object(value.model) &&
        typeof value.model.provider === "string" &&
        !!value.model.provider.trim() &&
        typeof value.model.id === "string" &&
        !!value.model.id.trim())) &&
    (value.effort === undefined || typeof value.effort === "string")
  );
}

function validSnapshot(data: unknown): data is ActiveSnapshot {
  return (
    object(data) &&
    typeof data.profile === "string" &&
    !!data.profile &&
    validRoute(data.route) &&
    validRoute(data.baseline) &&
    typeof data.activatedAt === "string" &&
    (data.cwd === undefined || typeof data.cwd === "string")
  );
}

function normalizedCwd(value: unknown): string | undefined {
  return typeof value === "string" && isAbsolute(value) ? resolve(value) : undefined;
}

export class SessionState {
  private active = new Map<string, ActiveSnapshot>();
  private off = new Set<string>();

  get(id?: string): ActiveSnapshot | undefined {
    return id ? this.active.get(id) : undefined;
  }

  shouldDefault(id?: string): boolean {
    return !!id && !this.active.has(id) && !this.off.has(id);
  }

  clear(id?: string): void {
    if (id) {
      this.active.delete(id);
      this.off.delete(id);
    } else {
      this.active.clear();
      this.off.clear();
    }
  }

  activate(pi: PiLike, ctx: ContextLike, snapshot: ActiveSnapshot): boolean {
    const id = ctx.sessionManager.getSessionId();
    if (!id) return false;

    const cwd = normalizedCwd(ctx.cwd);
    if (cwd) {
      try {
        pi.appendEntry(ACTIVE_ENTRY_TYPE, { ...snapshot, cwd });
      } catch {
        // Graceful degradation: memory-only
      }
    }

    this.off.delete(id);
    this.active.set(id, snapshot);
    return true;
  }

  deactivate(pi: PiLike, ctx: ContextLike): boolean {
    const id = ctx.sessionManager.getSessionId();
    if (!id) return false;

    const cwd = normalizedCwd(ctx.cwd);
    if (cwd) {
      try {
        pi.appendEntry(ACTIVE_ENTRY_TYPE, { off: true, cwd });
      } catch {
        // Graceful degradation: memory-only
      }
    }

    this.active.delete(id);
    this.off.add(id);
    return true;
  }

  restore(ctx: ContextLike): ActiveSnapshot | undefined {
    const id = ctx.sessionManager.getSessionId();
    const cwd = normalizedCwd(ctx.cwd);
    if (!id || !cwd) return undefined;

    let branch: unknown[];
    try {
      branch = ctx.sessionManager.getBranch();
    } catch {
      return undefined;
    }

    for (const entry of [...branch].reverse()) {
      if (
        !object(entry) ||
        entry.type !== "custom" ||
        entry.customType !== ACTIVE_ENTRY_TYPE
      ) {
        continue;
      }

      const marker = entry.data as Marker | undefined;
      if (!marker || typeof marker !== "object") continue;

      if (
        "off" in marker &&
        (marker as { off: boolean }).off &&
        normalizedCwd((marker as { cwd?: unknown }).cwd) === cwd
      ) {
        this.off.add(id);
        return undefined;
      }
      if (validSnapshot(marker) && normalizedCwd(marker.cwd) === cwd) {
        this.active.set(id, marker);
        return marker;
      }
    }

    return undefined;
  }
}
