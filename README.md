# pi-profiles-manager

`pi-profiles-manager` is a Pi Coding Agent extension for creating, selecting, editing, importing, and exporting SDD model profiles from an interactive terminal UI.

## Install

Prerequisites:

- Pi Coding Agent
- Node.js 22.19.0 or later (for development)

Install the published package with Pi:

```bash
pi install npm:pi-profiles-manager
```

Reload an active Pi session with `/reload` if needed.

## Use

Open the profile manager:

```text
/profiles
```

Common commands:

| Command | Action |
| --- | --- |
| `/profiles` | Open the interactive profile manager |
| `/profiles save <name>` | Save the current configuration as a profile |
| `/profiles list` | List saved profiles |
| `/profiles status` | Show the active profile for the session |
| `/profiles use <name>` | Activate a profile |
| `/profiles next` | Activate the next profile in the configured cycle |
| `/profiles off` | Disable the active profile for the session |

The default shortcut is `ctrl+tab` to activate the next profile.

## Features

1. Create, activate, edit, and delete profiles.
2. Import and export versioned profile strings.
3. Apply profile routes to the Pi session and `subagents.json`.
4. Mark a default profile for session startup and view active/default status in the UI.
5. Cycle profiles with a keyboard shortcut.

## Configuration

Profiles are stored in the Pi agent directory at:

```text
~/.pi/agent/pi-profiles/config.json
```

The extension creates the file and its parent directory when it saves a profile.

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

## Release status

Version `1.0.1` is published on npm. GitHub releases are created from annotated `v*` tags after the tag version is verified against `package.json`; that workflow does not publish to npm.

## License

MIT © javinnav
