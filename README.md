# Pi Profiles Manager

A TUI extension for the Pi Coding Agent to manage gentle-ai subagent configurations (`models.json`).

## Features
- **Profiles Dashboard**: List and manage all stored model profiles through a command-line TUI.
- **Activate Profiles**: Instantly apply a profile's underlying `agents` and `orchestrator` settings to your local `~/.pi/gentle-ai/models.json`.
- **Create Profiles**: Save your currently active `models.json` into a new profile, or create one completely from scratch within the TUI.
- **Edit Agents**: Deep dive into any profile to modify individual agents. Adjust the active model or thinking level (`low`, `medium`, `high`, `max`), and add/remove specific agent overrides.

## Usage
Simply run inside your active Pi session:
```
/profiles
```

Alternatively, to quickly save your current config without entering the full TUI:
```
/profiles save <name>
```

## Installation
Clone this repository into your Pi extensions directory:
```bash
git clone https://github.com/javinnav/pi-profiles-manager.git ~/.pi/agent/extensions/profiles-manager
```
Then reload your Pi session:
```text
/reload
```
