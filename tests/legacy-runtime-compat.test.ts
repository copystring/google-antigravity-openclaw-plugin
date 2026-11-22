import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import plugin from '../src/openclaw-plugin.js';

type Backend = {
  id: string;
  modelProvider: string;
  ownsNativeCompaction: boolean;
  manualCompaction?: {
    buildPrompt: (instructions?: string) => string;
    input: string;
    validateOutput: (raw: string) => { ok: boolean };
  };
  config: { command: string; args: string[]; resumeArgs: string[] };
  resolveExecutionArgs: (ctx: unknown) => string[];
};

function capture() {
  const backends: Backend[] = [];
  const providers: unknown[] = [];
  plugin.register({
    registerProvider(value: unknown) { providers.push(value); },
    registerModelCatalogProvider() {},
    registerCliBackend(value: unknown) { backends.push(value as Backend); },
  } as never);
  return { backends, providers };
}

describe('legacy Antigravity runtime compatibility', () => {
  it('declares both CLI backend names under one plugin without an old provider', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'),
    );
    expect(manifest.cliBackends).toEqual(['google-antigravity-cli', 'antigravity-cli']);
    expect(manifest.providers).toEqual(['google-antigravity-cli']);
    expect(Object.keys(manifest.modelCatalog.providers)).toEqual(['google-antigravity-cli']);
    expect(manifest.syntheticAuthRefs).toEqual(['google-antigravity-cli']);
  });

  it('keeps exactly one provider while registering the legacy runtime alias', () => {
    const { backends, providers } = capture();
    expect(providers).toHaveLength(1);
    expect(backends.map((backend) => backend.id)).toEqual([
      'google-antigravity-cli', 'antigravity-cli',
    ]);
    const [canonical, legacy] = backends;
    expect(canonical?.modelProvider).toBe('google-antigravity-cli');
    expect(legacy?.modelProvider).toBe('google-antigravity-cli');
    expect(legacy?.config).toEqual(canonical?.config);
    expect(legacy?.ownsNativeCompaction).toBe(true);
    expect(legacy?.manualCompaction?.input).toBe('stdin');
    expect(legacy?.manualCompaction?.buildPrompt()).toBe('/compact');
  });

  it('routes legacy bound native compaction through the new verified runner', () => {
    const { backends } = capture();
    const legacy = backends.find((backend) => backend.id === 'antigravity-cli')!;
    const previousConversationId = '91f5da53-b929-467b-a052-e2224bd02679';
    const args = legacy.resolveExecutionArgs({
      controlOperation: 'compact',
      useResume: true,
      baseArgs: [...legacy.config.resumeArgs.slice(0, -1), previousConversationId],
    });
    expect(args[0]).toMatch(/compact-cli\.js$/u);
    expect(args).toContain(previousConversationId);
    expect(legacy.manualCompaction?.validateOutput(JSON.stringify({
      type: 'compaction_complete',
      status: 'SUCCESS',
      checkpoint: true,
      conversation_id: previousConversationId,
    }))).toEqual({ ok: true });
    expect(() => legacy.resolveExecutionArgs({
      controlOperation: 'compact',
      useResume: false,
      baseArgs: legacy.config.args,
    })).toThrow(/resumable/);
  });
});
