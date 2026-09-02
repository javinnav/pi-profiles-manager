# pi-profiles-manager

`pi-profiles-manager` is a [Pi Coding Agent](https://github.com/badlogic/pi-mono) extension for saving, selecting, editing, importing, and exporting SDD model profiles. A profile can set an orchestrator model and thinking level, plus routes for managed subagents.

## Install

Prerequisites:

- Pi Coding Agent
- Node.js 22.19.0 or later (for development)

Install the published package:

```bash
pi install npm:pi-profiles-manager
```

Reload an active Pi session with `/reload` if needed.

## Pi command: `/profiles`

Pi registers one command: `/profiles`. Its actions are arguments to that command, not separate Pi commands such as `/profiles:sync`.

```text
/profiles
```

Open the interactive manager with no arguments. When entering an argument, Pi completion suggests supported actions; after `use` or `save`, it suggests matching saved profile names. Profile names may contain spaces.

| Command | Action |
| --- | --- |
| `/profiles` | Open the interactive profile manager. |
| `/profiles list` | List saved profiles. |
| `/profiles status` | Show the active profile for the current session. |
| `/profiles use <name>` | Activate a saved profile. |
| `/profiles save <name>` | Save the current configuration as a profile. |
| `/profiles next` | Activate the next profile in the configured cycle. |
| `/profiles off` | Disable the active profile for the current session. |
| `/profiles sync` | Discover managed `agents/*.md` files and reconcile every saved profile's subagent entries. It does not create Pi commands. |

The default shortcut, `ctrl+shift+p`, activates the next profile in the configured cycle.

## Where data lives

These locations have different purposes:

### Saved profile persistence

Saved profiles, the default profile, cycle, and shortcut preference are persisted in:

```text
~/.pi/agent/pi-profiles/config.json
```

The extension creates this file and its parent directory when it saves a profile.

### Managed subagent definitions

Pi agent markdown files live in the Pi agent directory:

```text
~/.pi/agent/agents/*.md
```

Run `/profiles sync` after adding or removing these files. Sync discovers their names and reconciles each saved profile: new managed agents receive a profile entry, and entries for removed markdown files are removed. Sync updates profile data; it does not register additional Pi slash commands.

### Applied subagent routes

When a profile is activated, its subagent routes are applied to Pi's global agent-route configuration:

```text
~/.pi/agent/subagents.json
```

This is separate from `pi-profiles/config.json`: the former is the active routing configuration Pi uses, while the latter stores the profiles that can be selected later.

## Features

- Create, activate, edit, and delete profiles.
- Import and export versioned profile strings.
- Set model and thinking routes for the orchestrator and managed subagents.
- Mark a default profile for session startup and view active/default status in the UI.
- Cycle profiles with a keyboard shortcut.

## Development

Clone this repository into your Pi extensions directory to develop it locally:

```bash
git clone https://github.com/javinnav/pi-profiles-manager.git ~/.pi/agent/extensions/profiles-manager
cd ~/.pi/agent/extensions/profiles-manager
npm ci
npm test
npm run typecheck
npm run package-check
```

## License

MIT © javinnav
