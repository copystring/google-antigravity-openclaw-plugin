import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import plugin from '../src/openclaw-plugin.js';
import {
  clearAgyCatalogCache,
  discoverAgyModels,
  hasVerifiedAgySession,
  parseAgyModelsJson,
} from '../src/agy-catalog.js';
import {
  AGY_PROVIDER_ID,
  buildAgyProviderConfig,
  makeAgyProvider,
  toAgyCatalogRows,
} from '../src/agy-provider.js';

const rows = [
  { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
  { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  { id: 'claude-sonnet-5-1', label: 'Claude Sonnet 5.1' },
];
const modelsResult = (items: unknown = rows) => JSON.stringify({
  status: 'SUCCESS',
  command: { name: 'models', data: { models: items } },
});

describe('live Antigravity model catalog', () => {
  beforeEach(() => {
    clearAgyCatalogCache();
  });

  it('reads only successful command.models entries without inventing model ids', () => {
    expect(parseAgyModelsJson(modelsResult())).toEqual([
      { id: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
      { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
      { id: 'claude-sonnet-5-1', name: 'Claude Sonnet 5.1' },
    ]);
    expect(parseAgyModelsJson(modelsResult([
      { id: 'gemini-4-neon', label: 'Gemini 4 Neon' },
      { id: 'gemini-4-neon', label: 'Duplicate' },
      { id: '--eval', label: 'Bad' },
      { id: 'malformed id', label: 'Bad' },
      { id: 'gemini-4-carbon', label: '' },
    ]))).toEqual([{ id: 'gemini-4-neon', name: 'Gemini 4 Neon' }]);
  });

  it('fails closed on errors, text-only responses and invalid models', () => {
    expect(parseAgyModelsJson('not json')).toEqual([]);
    expect(parseAgyModelsJson(JSON.stringify({ status: 'ERROR', command: { name: 'models', data: { models: rows } } }))).toEqual([]);
    expect(parseAgyModelsJson(JSON.stringify({ status: 'SUCCESS', response: 'Gemini 4 Neon' }))).toEqual([]);
    expect(parseAgyModelsJson(modelsResult([]))).toEqual([]);
    expect(parseAgyModelsJson(modelsResult([{ id: '../escape', label: 'No' }]))).toEqual([]);
  });

  it('deduplicates concurrent model discovery and caches for five minutes', async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'agy-catalog-test-'));
    const binary = path.join(fixture, 'agy');
    await writeFile(binary, 'test');
    try {
      let count = 0;
      const env = { ...process.env, AGY_PATH: binary };
      const runner = async () => {
        count += 1;
        return { exitCode: 0, stdout: modelsResult() };
      };
      const [first, second] = await Promise.all([
        discoverAgyModels({ env, runner }),
        discoverAgyModels({ env, runner }),
      ]);
      expect(count).toBe(1);
      expect(first?.models).toEqual(second?.models);
      expect(hasVerifiedAgySession()).toBe(true);
      const cached = await discoverAgyModels({ env, runner });
      expect(cached?.source).toBe('cache');
      expect(count).toBe(1);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('does not report native authentication after a failed CLI discovery', async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'agy-catalog-fail-test-'));
    const binary = path.join(fixture, 'agy');
    await writeFile(binary, 'test');
    try {
      const env = { ...process.env, AGY_PATH: binary };
      const result = await discoverAgyModels({
        env,
        runner: async () => ({ exitCode: 1, stdout: 'Please sign in' }),
      });
      expect(result).toBeNull();
      expect(hasVerifiedAgySession()).toBe(false);
      const provider = makeAgyProvider();
      expect(provider.resolveSyntheticAuth?.({ provider: AGY_PROVIDER_ID })).toBeNull();
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('uses the existing native CLI and never creates or imports credentials', async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'agy-catalog-cli-test-'));
    const binary = path.join(fixture, 'agy');
    const fake = [
      '#!/usr/bin/env node',
      "if (process.argv.slice(2).join(' ') !== '--output-format json models') process.exit(1);",
      'console.log(' + JSON.stringify(modelsResult()) + ');',
    ].join('\n');
    await writeFile(binary, fake);
    await chmod(binary, 0o755);
    try {
      const env = { ...process.env, AGY_PATH: binary };
      const provider = makeAgyProvider();
      const prepared = await provider.prepareSyntheticAuth?.({ provider: AGY_PROVIDER_ID, env });
      expect(prepared).toMatchObject({ mode: 'api-key', source: 'verified local agy CLI session' });
      expect(provider.resolveSyntheticAuth?.({ provider: AGY_PROVIDER_ID })).toMatchObject({
        apiKey: 'antigravity-local-session',
      });
      const result = await discoverAgyModels({ env });
      expect(result?.models).toHaveLength(rows.length);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('builds CLI runtime entries and provider-owned live catalog without static models', async () => {
    const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
    expect(manifest.modelCatalog.providers[AGY_PROVIDER_ID].models).toEqual([]);
    expect(manifest.modelCatalog.discovery[AGY_PROVIDER_ID]).toBe('refreshable');
    expect(manifest.nonSecretAuthMarkers).toEqual(['antigravity-local-session']);
    expect(manifest.providerCatalogEntry).toBe('./dist/provider-discovery.js');
    const spec = buildAgyProviderConfig([{ id: 'gemini-4-neon', name: 'Gemini 4 Neon' }]);
    expect(spec.agentRuntime).toEqual({ id: AGY_PROVIDER_ID });
    expect(spec.models[0].agentRuntime).toEqual({ id: AGY_PROVIDER_ID });
    const result = toAgyCatalogRows({
      models: [{ id: 'gemini-4-neon', name: 'Gemini 4 Neon' }],
      source: 'live',
      fetchedAt: 1,
      expiresAt: 2,
    });
    expect(result).toMatchObject([
      { kind: 'text', provider: AGY_PROVIDER_ID, model: 'gemini-4-neon', label: 'Gemini 4 Neon', source: 'live' },
    ]);
    let provider: unknown;
    let catalog: unknown;
    plugin.register({
      registerProvider(value: unknown) { provider = value; },
      registerModelCatalogProvider(value: unknown) { catalog = value; },
      registerCliBackend() {},
    } as never);
    expect(provider).toBeDefined();
    expect(catalog).toMatchObject({ provider: AGY_PROVIDER_ID, kinds: ['text'] });
    expect((catalog as { staticCatalog?: unknown }).staticCatalog).toBeUndefined();
  });
});
