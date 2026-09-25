# Google Antigravity OpenClaw plugin

This repository contains the OpenClaw native CLI backend plugin for Google
Antigravity. The independent ACP server and Antigravity process adapter remain
in [google-antigravity-acp](https://github.com/sibbl/google-antigravity-acp).

The plugin uses the ACP package's `google-antigravity-cli` executable and keeps
its OpenClaw SDK dependency, compatibility declaration, and host minimum in
this repository. Plugin SDK changes can therefore be tested and released
against the intended OpenClaw version without coupling ACP-only users to that
release cadence.

## Install

```bash
openclaw plugins install google-antigravity-openclaw-plugin
openclaw config set plugins.entries.google-antigravity-cli.enabled true
```

The installed package requires OpenClaw 2026.9.6 or newer and installs
`google-antigravity-acp` as its runtime dependency. Authentication remains owned
by the official `agy` installation.

Select a model and require the plugin-owned runtime:

```json5
{
  agents: {
    entries: {
      fast: {
        model: {
          primary: "google-antigravity-cli/gemini-3.8-flash-low",
          fallbacks: [],
        },
        models: {
          "google-antigravity-cli/gemini-3.8-flash-low": {
            agentRuntime: { id: "google-antigravity-cli" },
          },
        },
      },
    },
  },
}
```

For OpenClaw runs with an exact tool cap, the backend creates a private
per-run Antigravity home, denies native file, shell, and web permissions,
passes through only the minimum authentication and conversation state, and
exposes only OpenClaw's host-isolated MCP bridge. Antigravity and the bridge
both enforce the requested OpenClaw tool list. Exact-cap runs require
Antigravity CLI 1.1.9 or newer and fail closed when native tools are requested;
unrestricted turns keep the normal native tool behavior and additionally
receive the OpenClaw MCP bridge.

## Development

The checked-in OpenClaw SDK version is the version used to compile this plugin.
Before moving that pin, update the build and compatibility metadata together.
`npm run build` checks that these values stay aligned.

```bash
npm ci
npm test
npm run build
```

The Plugin SDK is an experimental API; test this package against each OpenClaw
release before lowering its minimum host version.
