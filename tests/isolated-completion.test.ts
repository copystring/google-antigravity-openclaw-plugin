import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import plugin, {
  prepareExactToolHome,
  validateIsolatedCompletion,
} from '../src/openclaw-plugin.js';

type Prepared = {
  env?: Record<string, string>;
  clearEnv?: string[];
  isolatedCompletionEnforced?: boolean;
  toolAvailabilityEnforced?: boolean;
  cleanup?: () => Promise<void>;
};

type Backend = {
  prepareExecution: (ctx: unknown) => Promise<Prepared | undefined>;
  resolveExecutionArgs: (ctx: unknown) => string[];
};

function createBackend(): Backend {
  let backend: Backend | undefined;
  plugin.register({
    registerProvider() {},
    registerModelCatalogProvider() {},
    registerCliBackend(value: unknown) {
      backend = value as Backend;
    },
  } as never);
  if (!backend) throw new Error('Missing Antigravity CLI backend');
  return backend;
}

describe('isolated utility completion contract', () => {
  const zeroTools = { native: [], openClaw: [] };
  const isolatedCtx = {
    modelId: 'gemini-3.8-flash-low',
    isolatedCompletionModelId: 'gemini-3.8-flash-low',
    isolatedCompletionSystemPrompt: 'Respond only with a JSON object.',
    isolatedCompletionPrompt: 'Classify the session status.',
    toolAvailability: zeroTools,
  };

  it('accepts an exact zero-tool isolated completion', () => {
    expect(validateIsolatedCompletion(isolatedCtx)).toBe(true);
  });

  it('does not claim isolation for an ordinary execution', () => {
    expect(validateIsolatedCompletion({
      ...isolatedCtx,
      isolatedCompletionSystemPrompt: undefined,
    })).toBe(false);
  });

  it('rejects missing, ambiguous or mismatched models and tool grants', () => {
    expect(() => validateIsolatedCompletion({
      ...isolatedCtx,
      isolatedCompletionPrompt: undefined,
    })).toThrow(/literal prompt/);
    expect(() => validateIsolatedCompletion({
      ...isolatedCtx,
      isolatedCompletionModelId: 'auto',
    })).toThrow(/concrete/);
    expect(() => validateIsolatedCompletion({
      ...isolatedCtx,
      isolatedCompletionModelId: 'another-model',
    })).toThrow(/matching/);
    expect(() => validateIsolatedCompletion({
      ...isolatedCtx,
      toolAvailability: { native: ['shell'], openClaw: [] },
    })).toThrow(/zero tools/);
    expect(() => validateIsolatedCompletion({
      ...isolatedCtx,
      toolAvailability: { native: [], openClaw: ['exec'] },
    })).toThrow(/zero tools/);
    expect(() => validateIsolatedCompletion({
      ...isolatedCtx,
      toolAvailability: undefined,
    })).toThrow(/zero tools/);
  });

  it('rejects Antigravity native include and command syntax', () => {
    for (const prompt of ['@./secret', 'Please read @private-file', ' /resume', '!cat /etc/passwd']) {
      expect(() => validateIsolatedCompletion({
        ...isolatedCtx,
        isolatedCompletionPrompt: prompt,
      })).toThrow(/unsafe/);
    }
    expect(() => validateIsolatedCompletion({
      ...isolatedCtx,
      isolatedCompletionSystemPrompt: 'Load @private-file',
    })).toThrow(/unsafe/);
    expect(() => validateIsolatedCompletion({
      ...isolatedCtx,
      isolatedCompletionPrompt: 'foo\u0000bar',
    })).toThrow(/unsafe/);
  });

  it('copies credentials without sharing existing conversations', async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'agy-isolated-test-'));
    const sourceHome = path.join(fixture, 'source-home');
    const sourceRuntime = path.join(sourceHome, '.gemini', 'antigravity-cli');
    await mkdir(path.join(sourceRuntime, 'conversations'), { recursive: true });
    await writeFile(path.join(sourceRuntime, 'antigravity-oauth-token'), 'test-token');
    await writeFile(path.join(sourceRuntime, 'installation_id'), 'test-installation');
    await writeFile(path.join(sourceRuntime, 'conversations', 'old-session.json'), 'private');
    await writeFile(path.join(sourceRuntime, 'conversation_summaries.db'), 'private');
    await writeFile(path.join(sourceRuntime, 'settings.json'), '{"unsafe":true}');

    const prepared = await prepareExactToolHome({
      toolAvailability: zeroTools,
      sourceHome,
      temporaryRoot: fixture,
      isolatedCompletion: true,
    });
    try {
      const runtime = path.join(prepared.home, '.gemini', 'antigravity-cli');
      expect(await readFile(path.join(runtime, 'antigravity-oauth-token'), 'utf8')).toBe('test-token');
      await writeFile(path.join(runtime, 'antigravity-oauth-token'), 'changed-in-sandbox');
      expect(await readFile(path.join(sourceRuntime, 'antigravity-oauth-token'), 'utf8')).toBe('test-token');
      await expect(access(path.join(runtime, 'conversations'))).rejects.toThrow();
      await expect(access(path.join(runtime, 'conversation_summaries.db'))).rejects.toThrow();
      const settings = JSON.parse(await readFile(path.join(runtime, 'settings.json'), 'utf8'));
      expect(settings.unsafe).toBeUndefined();
      expect(settings.mcp.allowed).toEqual([]);
      expect(settings.permissions.deny).toContain('mcp(*)');
      expect(settings.permissions.deny).toContain('read_file(*)');
      expect(settings.permissions.deny).toContain('command(*)');
    } finally {
      await prepared.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('rejects native tool grants at the private-home boundary', async () => {
    await expect(prepareExactToolHome({
      toolAvailability: { native: ['read_file'], openClaw: [] },
      isolatedCompletion: true,
    })).rejects.toThrow(/OpenClaw MCP tools only/);
  });

  it('refuses to resume an existing tool-free conversation', () => {
    const backend = createBackend();
    expect(() => backend.resolveExecutionArgs({
      baseArgs: [],
      useResume: true,
      toolAvailability: zeroTools,
    })).toThrow(/cannot resume/);
    expect(() => backend.resolveExecutionArgs({
      baseArgs: ['--conversation=old-session'],
      useResume: false,
      toolAvailability: zeroTools,
    })).toThrow(/cannot resume/);
  });

  it('only acknowledges isolation after an exact tool-free preparation', async () => {
    const backend = createBackend();
    const isolated = await backend.prepareExecution({ ...isolatedCtx, env: {} });
    try {
      expect(isolated?.isolatedCompletionEnforced).toBe(true);
      expect(isolated?.toolAvailabilityEnforced).toBe(true);
      expect(isolated?.env?.OPENCLAW_ANTIGRAVITY_EXACT_TOOLS).toBe('1');
      expect(isolated?.clearEnv).toContain('GEMINI_CLI_SYSTEM_SETTINGS_PATH');
      expect(isolated?.clearEnv).toContain('ANTIGRAVITY_USER_DATA_DIR');
      expect(isolated?.clearEnv).toContain('NODE_OPTIONS');
    } finally {
      await isolated?.cleanup?.();
    }
    const regular = await backend.prepareExecution({
      modelId: 'gemini-3.8-flash-low',
      toolAvailability: zeroTools,
      env: {},
    });
    try {
      expect(regular?.toolAvailabilityEnforced).toBe(true);
      expect(regular?.isolatedCompletionEnforced).toBeUndefined();
    } finally {
      await regular?.cleanup?.();
    }
  });
});
