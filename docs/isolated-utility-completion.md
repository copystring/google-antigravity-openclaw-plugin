# Isolated utility completion (OpenClaw 2026.11.6)

This branch adds a development implementation for the session observer's isolated, zero-tool utility requests.

## Behavior

- Require a concrete model and exactly zero native/OpenClaw tools.
- Reject native `@` includes, leading slash commands and shell command prefixes.
- Use a fresh temporary `HOME` and working directory with restrictive CLI settings.
- Copy only the CLI authentication token and installation identifier; exclude prior conversations, summaries, skills and extensions.
- Clear inherited data and prompt paths, as well as Node.js injection environment variables.
- Refuse resuming a tool-free conversation and clean up temporary state after execution.
- Leave ordinary coding requests and agent model configuration unchanged.

## Local verification

```bash
npm ci
npm test
npm run build
```

Unit tests are in `tests/isolated-completion.test.ts`.

## Known limitations

**This is not yet production validated.** The dependency `google-antigravity-acp` embeds the isolated system prompt in the request text instead of passing it through a dedicated native system-instruction channel. Before deployment, independently verify that the native CLI preserves strict instruction isolation, denies tools, never resumes a prior conversation, and rejects unsafe prompt syntax.

Test on a separate OpenClaw test gateway, never by replacing the running global plugin. The fix does not address the unrelated 360-second coding fallback stall or the 30-second session-observer timeout issue.

The CLI remains owned by Google; using a private Google AI subscription through OpenClaw may violate its terms.
