import { describe, expect, it } from 'vitest';
import plugin from '../src/openclaw-plugin.js';
import { validateNativeCompactionOutput } from '../src/compact-protocol.js';

type Backend = {
  manualCompaction?: {
    buildPrompt: (instructions?: string) => string;
    input: string;
    validateOutput: typeof validateNativeCompactionOutput;
  };
  resolveExecutionArgs: (ctx: unknown) => string[];
  config: { args: string[]; resumeArgs: string[] };
};

function backend(): Backend {
  let registered: Backend | undefined;
  plugin.register({
    registerProvider() {},
    registerModelCatalogProvider() {},
    registerCliBackend(value: unknown) { registered = value as Backend; },
  } as never);
  if (!registered) throw new Error('Missing CLI backend');
  return registered;
}

describe('Antigravity manual compaction', () => {
  it('requires verified checkpoint and success, not an empty answer', () => {
    const done = JSON.stringify({
      type: 'compaction_complete',
      status: 'SUCCESS',
      checkpoint: true,
      conversation_id: '91f5da53-b929-467b-a052-e2224bd02679',
    });
    expect(validateNativeCompactionOutput(done)).toEqual({ ok: true });
    for (const invalid of [
      '',
      'Conversation compacted',
      '{"type":"result","status":"SUCCESS","text":""}',
      '{"type":"compaction_complete","status":"SUCCESS","checkpoint":false}',
      '{"type":"compaction_complete","status":"ERROR","checkpoint":true}',
    ]) {
      expect(validateNativeCompactionOutput(invalid).ok).toBe(false);
    }
  });

  it('registers bare /compact as an explicit native control operation', () => {
    const value = backend();
    expect(value.manualCompaction?.input).toBe('stdin');
    expect(value.manualCompaction?.buildPrompt()).toBe('/compact');
    expect(() => value.manualCompaction?.buildPrompt('continue editing')).toThrow(/bare/);
  });

  it('uses a separate native compact runner for resumed conversations only', () => {
    const value = backend();
    const path = value.config.args[0]!;
    const ctx = {
      baseArgs: [path, '--conversation', '91f5da53-b929-467b-a052-e2224bd02679'],
      useResume: true,
      controlOperation: 'compact',
    };
    const result = value.resolveExecutionArgs(ctx);
    expect(result[0]).toMatch(/compact-cli\.js$/u);
    expect(result).toContain('91f5da53-b929-467b-a052-e2224bd02679');
    expect(value.config.args[0]).toContain('one-shot-cli.js');
    expect(() => value.resolveExecutionArgs({ ...ctx, useResume: false })).toThrow(/resumable/);
    expect(() => value.resolveExecutionArgs({
      ...ctx,
      toolAvailability: { native: ['shell'], openClaw: [] },
    })).toThrow(/exposed tools/);
    expect(value.resolveExecutionArgs({
      baseArgs: [path],
      useResume: false,
    })[0]).toMatch(/normal-cli\.js$/u);
  });
});
