# pi-profiles-manager 🚀

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

### 2. Native Pi Integration 
- Fully built on top of `@earendil-works/pi-tui`.
- Works flawlessly with overlay navigation, meaning your terminal output isn't erased when interacting with profiles.

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

Clone this repository directly into your Pi extensions directory:

```bash
git clone https://github.com/javinnav/pi-profiles-manager.git ~/.pi/agent/extensions/profiles-manager
```

Apply the changes immediately by reloading the active session:

```text
/reload
```

---

## 🚀 Usage

*Ensure the active Pi Session recognizes the newly linked extension context.*

Open the Profiles Manager by triggering its slash command:

```text
/profiles
```

Alternatively, to quickly snapshot your current session's `models.json` without routing through the UI:

```text
/profiles save <profile-name>
```

---

## 💖 Credits and Acknowledgments

- **Inspiration:** Developed mirroring the clean extension and TUI architecture provided by [opencode-sdd-engram-manage](https://github.com/j0k3r-dev-rgl/sdd-engram-plugin) from @j0k3r-dev-rgl. 
- **Dependencies:** Built leveraging the core APIs of the [Pi Coding Agent framework](https://github.com/earendil-works/pi-mono). 
- **Ecosystem:** Powered by [Gentle AI (OpenCode)](https://github.com/Gentleman-Programming/gentle-ai).
