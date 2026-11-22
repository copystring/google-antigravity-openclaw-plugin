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
The npm package version follows that same OpenClaw release version. Before
moving the pin, update the package version and compatibility metadata together.
`npm run build` checks that these values stay aligned.

```bash
npm ci
npm test
npm run build
```

The Plugin SDK is an experimental API; test this package against each OpenClaw
release before lowering its minimum host version.

## Dynamic model catalog and native login recognition

The fork queries the already installed official Antigravity CLI:

```bash
agy --output-format json models
```

Only a successful response containing command.data.models can verify the native
CLI session and publish a model catalog. OpenClaw does not import Google OAuth
tokens or create a second account. The original CLI owns authentication.

- The picker receives model IDs and names returned by agy, not hard-coded rows.
- Results are cached for five minutes and in-flight lookups are shared.
- An expired or temporarily unavailable CLI can reuse the last successful list,
  but a failed probe cannot claim a new successful login.
- The model-catalog manifest contains no hard-coded entitlement list.
- No setup wizard, proxy, model router or global agent setting is added.
- Model context metadata is a conservative compatibility estimate; the CLI
  output does not publish context capacity information.

Refresh the model catalog:

```bash
openclaw models list --provider google-antigravity-cli --refresh
openclaw models status
```

If models do not appear, verify that agy --output-format json models works
under the same Linux user as the Gateway. The CLI query can take time on a cold start.

Using private Google AI subscription quotas through a third-party OpenClaw
integration may be outside Google's permitted usage; direct CLI transport
does not change that policy.

## Legacy native session compatibility

The same plugin registers two CLI backend IDs:

- `google-antigravity-cli`: the canonical runtime for new requests.
- `antigravity-cli`: a compatibility alias for older cavi-ai-backed sessions.

Both map to the single canonical model provider `google-antigravity-cli` and
use the same native `agy` executable and manual compaction control command.
This lets OpenClaw 2026.11.6 recognize a previously saved
`cliSessionBindings['antigravity-cli']` when a session now selects
`google-antigravity-cli/<model>`, without altering SQLite data or restarting
the Gateway. The old `antigravity` plugin must remain **disabled** to avoid
two active plugins claiming the same backend ID.

Native compaction of a legacy conversation is not yet verified end to end.
Do not treat compile or unit-test success as proof that the installed `agy`
will confirm the checkpoint. Back up important conversations before manual
native compaction.

## Native CLI token accounting

The official `agy` terminal `usage` block aggregates token consumption over
internal model calls; it does **not** identify the current prompt-context size
after a native `/compact`. OpenClaw 2026.11.6 interprets a plugin's JSONL
`result.usage` as the latest model-call usage and marks its derived context
snapshot fresh. Passing agy's aggregate counters through that field could
make the chat display millions of context tokens against a smaller window.

Until agy exposes an authoritative per-call prompt/context measurement, this
plugin intentionally omits `usage` from OpenClaw JSONL result events. This
prevents new unsupported context measurements, but also means OpenClaw cannot
show reliable Antigravity per-turn token billing/usage numbers from this
adapter. Older persisted context counters are not modified by installing
the plugin; the Gateway may continue displaying them as stale/approximate
until it obtains a trustworthy replacement. The native compact command
still preserves the session and does not synthesize a fake token count.

OpenClaw metadata fields such as `contextTokens` can reflect previously
selected runtimes. The Gemini model-catalog context size is an estimate,
not a value returned by the CLI's model discovery endpoint.
