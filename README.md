# pi-profiles-manager 🚀

[![npm version](https://badge.fury.io/js/pi-profiles-manager.svg)](https://badge.fury.io/js/pi-profiles-manager)

Interactive SDD model profile management built natively for the [Pi Coding Agent](https://github.com/earendil-works/pi-mono).

Manage your Gentle AI `models.json` configurations dynamically from a beautiful Terminal User Interface (TUI) without ever leaving your session.

---

## 🌟 Features

### 1. Unified Profile Management

Manage all your SDD (Spec-Driven Development) profiles via a rich interface:

- **Create:** Read your current `models.json` setup and save it as a new profile instantly.
- **Activate:** Apply a saved profile into the global runtime config. Changes affect the executing session immediately with no restarts required.
- **Edit Agent Nodes:** Individually adjust `model` strings and `thinking` tiers (`low`, `medium`, `high`, `xhigh`, `max`) for any agent (`sdd-*`, `jd-*`, `review-*`, etc.).
- **Scaffold Empty Agents:** Add specific overrides for single agents right from the UI.
- **Delete:** Remove outdated tiers and profiles to keep your workspace tidy.

### 2. Keyboard Shortcuts

- **`ctrl+tab`** — Cycle through configured profiles instantly. Both model and thinking level apply live.
- **`/profiles next`** — Cycle to the next profile via slash command.
- **`/profiles use <name>`** — Activate a specific profile by name.
- **`/profiles off`** — Deactivate and restore your original session baseline.

### 3. Session Persistence

- Active profile survives session restarts and reloads.
- Automatically restores your last active profile on `session_start`.
- Set a `defaultProfile` in config to auto-apply on new sessions.

### 4. Live Effort Application

- `setThinkingLevel()` is called on activation — effort takes effect immediately.
- Baseline model + thinking level captured on first activation for safe rollback.
- `"inherit"` effort means "don't change the current thinking level".

### 5. Native Pi Integration

- Fully built on top of `@earendil-works/pi-tui`.
- Works flawlessly with overlay navigation, meaning your terminal output isn't erased when interacting with profiles.
- Status bar indicator shows the active profile.

---

## 📸 Interface Preview (Compact Format)

```text
Profiles Manager
──────────────────────────────────────────────────
> ✨ Create New Profile from Current Config
  FREE
  antigravity
  deus

↑↓ navigate • enter select • esc close
```

```text
Action for 'antigravity'
──────────────────────────────────────────────────
> ▶ Activate         Apply this profile to models.json
  ✎ Edit             Modify agents in this profile
  ✖ Delete           Remove this profile
  ← Back             Return to profile list
```

```text
Edit Profile 'antigravity'
──────────────────────────────────────────────────
> orchestrator       omni/antigravity/gemini-pro-agent (medium)
  jd-fix-agent       omniroute/gemini-flash-low (high)
  ...
  ➕ Add Subagent    Add a specific configuration for a subagent
```

---

## 🛠 Installation

Because `pi-profiles-manager` is an officially published Pi Package, you can install it seamlessly using the native Pi package manager:

```bash
pi install npm:pi-profiles-manager
```

*Note: Once installed, any running Pi sessions should automatically pick it up, or you can run `/reload` in an active session.*

### Manual Installation (Development)

If you wish to modify the code yourself, clone this repository directly into your Pi extensions directory:

```bash
git clone https://github.com/javinnav/pi-profiles-manager.git ~/.pi/agent/extensions/profiles-manager
```

---

## 🚀 Usage

### Slash Commands

| Command | Action |
| --------- | -------- |
| `/profiles` | Open the interactive profile manager TUI |
| `/profiles list` | List all configured profiles |
| `/profiles status` | Show the active profile (or "none") |
| `/profiles use <name>` | Activate a specific profile |
| `/profiles next` | Cycle to the next profile |
| `/profiles off` | Deactivate and restore baseline |
| `/profiles save <name>` | Quick-save current config as a profile |

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `ctrl+tab` | Cycle through profiles |

---

## ⚙️ Configuration

Profiles are stored in `~/.pi/gentle-ai/sdd-profiles-manager.json` and use a versioned schema:

```json
{
  "version": 1,
  "shortcut": "ctrl+tab",
  "defaultProfile": "review",
  "cycle": ["review", "fast"],
  "profiles": {
    "review": {
      "order": 0,
      "orchestrator": {
        "model": { "provider": "anthropic", "id": "claude-sonnet" },
        "effort": "high"
      }
    },
    "fast": {
      "order": 1,
      "orchestrator": {
        "model": { "provider": "openai", "id": "gpt-4.1" },
        "effort": "low"
      }
    }
  }
}
```

| Field | Description |
| ------- | ------------- |
| `version` | Schema version (currently `1`) |
| `shortcut` | Global cycling shortcut (default: `ctrl+tab`) |
| `defaultProfile` | Profile to auto-apply on new sessions |
| `cycle` | Optional ordered list for cycling (overrides `order`) |
| `order` | Integer for profile ordering |
| `orchestrator` | Model + effort for the parent session |
| `effort` | One of: `inherit`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |

**Legacy migration:** Existing unversioned config files are automatically migrated to v2 on first load.

---

## 💖 Credits and Acknowledgments

- **Inspiration:** Keyboard shortcuts and session persistence inspired by [pi-multi-profiles](https://github.com/Gioryopool/pi-multi-profiles) by @Gioryopool.
- **Architecture:** Developed mirroring the clean extension and TUI architecture provided by [opencode-sdd-engram-manage](https://github.com/j0k3r-dev-rgl/sdd-engram-plugin) from @j0k3r-dev-rgl.
- **Dependencies:** Built leveraging the core APIs of the [Pi Coding Agent framework](https://github.com/earendil-works/pi-mono).
- **Ecosystem:** Powered by [Gentle AI (OpenCode)](https://github.com/Gentleman-Programming/gentle-ai).
