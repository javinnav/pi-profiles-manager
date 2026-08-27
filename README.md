# pi-profiles-manager 🚀

[![npm version](https://badge.fury.io/js/pi-profiles-manager.svg)](https://badge.fury.io/js/pi-profiles-manager)

Interactive SDD model profile management built natively for the [Pi Coding Agent](https://github.com/earendil-works/pi-mono).

Manage your Gentle AI configurations dynamically from a beautiful Terminal User Interface (TUI) without ever leaving your session.

---

## 🌟 Features

### 1. Unified Profile Management

Manage all your SDD (Spec-Driven Development) profiles via a rich interface:

- **Create:** Read your current `models.json` setup and save it as a new profile instantly.
- **Activate:** Apply a saved profile into the global runtime config. Changes affect the executing session immediately.
- **Edit Agent Nodes:** Individually adjust `model` strings and `thinking` tiers (`low`, `medium`, `high`, `xhigh`, `max`) for any agent (`sdd-*`, `jd-*`, `review-*`, etc.).
- **Delete:** Remove outdated profiles to keep your workspace tidy.

### 2. Sharable Export & Import

- **Export:** Safely export a complete profile into a versioned, self-identifying string format (e.g., `piprofile:1:...`).
- **Import:** Copy-paste shared profile strings to instantly acquire customized agent setups without name collision issues. Invalid strings or unsupported version formats are cleanly handled.

### 3. Live Synchronization

- **Subagents Integration:** When activating a profile, `pi-profiles-manager` now correctly synchronizes model routes directly into `subagents.json`, guaranteeing flawless background agent execution.
- **Main Model Updates:** Instantly applies the chosen orchestrator model to your active session.

### 3. Active and Favorite Profiles

- **Visual Indicators:** The UI explicitly flags your active profile with `[▶ Active]` and your session default with `[★ Favorite]`.
- **Status Bar Integration:** Instantly see your currently activated profile in the Pi status bar.
- **Auto-Activation:** Mark a profile as "Favorite" via the UI menu. On `session_start`, `pi-profiles-manager` will automatically find and activate your favorite profile.
- **Fallback Inference:** If no favorite profile is configured, new sessions intelligently infer the active profile name by comparing your active `models.json` orchestrator to your saved profiles.

### 4. Keyboard Shortcuts

- **`ctrl+shift+p`** — Cycle through configured profiles instantly without opening the UI. Both model and thinking levels apply live.

### 5. Native Pi Integration

- Fully built on top of `@earendil-works/pi-tui`.
- Works flawlessly with overlay navigation, meaning your terminal output isn't erased when interacting with profiles.

---

## 📸 Interface Preview (Compact Format)

```text
Profiles Manager
──────────────────────────────────────────────────
> ✨ Create New Profile from Current Config
  📥 Import Profile from String
  work [▶ Active] [★ Favorite]
  low-tier

↑↓ navigate • enter select • esc close
```

```text
Action for 'work'
──────────────────────────────────────────────────
> ▶ Activate         Apply this profile and switch main model
  ★ Set as Favorite  Mark this profile as the session default
  ✎ Edit             Modify agents in this profile
  📤 Export to String Share this profile as a string
  ✖ Delete           Remove this profile
  ← Back             Return to profile list
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
| `/profiles save <name>` | Quick-save current config as a profile |

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `ctrl+shift+p` | Cycle to the next configured profile |

---

## ⚙️ Configuration File Structure

Profiles are stored in `~/.pi/gentle-ai/sdd-profiles-manager.json` as a flat JSON record:

```json
{
  "work": {
    "name": "work",
    "favorite": true,
    "orchestrator": {
      "model": "provider/main-model",
      "thinking": "high"
    },
    "agents": {
      "sdd-apply": {
        "model": "provider/worker-model",
        "thinking": "medium"
      }
    }
  }
}
```

---

## 💖 Credits and Acknowledgments

- **Inspiration:** Keyboard shortcuts and session persistence inspired by [pi-multi-profiles](https://github.com/Gioryopool/pi-multi-profiles) by @Gioryopool.
- **Architecture:** Developed mirroring the clean extension and TUI architecture provided by [opencode-sdd-engram-manage](https://github.com/j0k3r-dev-rgl/sdd-engram-plugin) from @j0k3r-dev-rgl.
- **Dependencies:** Built leveraging the core APIs of the [Pi Coding Agent framework](https://github.com/earendil-works/pi-mono).
- **Ecosystem:** Powered by [Gentle AI (OpenCode)](https://github.com/Gentleman-Programming/gentle-ai).
