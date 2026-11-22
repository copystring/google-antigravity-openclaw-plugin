import type {
  ProviderPlugin,
  UnifiedModelCatalogProviderPlugin,
} from 'openclaw/plugin-sdk/plugin-entry';
import {
  discoverAgyModels,
  hasVerifiedAgySession,
  type AgyCatalogModel,
  type AgyCatalogSnapshot,
} from './agy-catalog.js';

export const AGY_PROVIDER_ID = 'google-antigravity-cli';
export const AGY_AUTH_MARKER = 'antigravity-local-session';

const syntheticAuth = () => ({
  apiKey: AGY_AUTH_MARKER,
  source: 'verified local agy CLI session',
  mode: 'api-key' as const,
});

export function isAgyModelId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value);
}

/**
 * CLI-only provider metadata. These are conservative context estimates, not
 * entitlements returned by Google. The model names/IDs come from agy itself.
 */
function modelSpec(model: AgyCatalogModel) {
  const contextWindow = model.id.startsWith('gemini-')
    ? 1_000_000
    : model.id.startsWith('claude-')
      ? 200_000
      : 128_000;
  return {
    id: model.id,
    name: model.name,
    reasoning: model.id.startsWith('gemini-') ||
      model.id.includes('thinking') ||
      /-(?:low|medium|high|xhigh|max)$/u.test(model.id),
    input: ['text'] as const,
    contextWindow,
    maxTokens: 32_768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    agentRuntime: { id: AGY_PROVIDER_ID },
  };
}

export function buildAgyProviderConfig(models: readonly AgyCatalogModel[]) {
  return {
    baseUrl: 'http://antigravity.local',
    apiKey: AGY_AUTH_MARKER,
    api: 'google-generative-ai' as const,
    agentRuntime: { id: AGY_PROVIDER_ID },
    models: models.map((model) => ({
      ...modelSpec(model),
      input: ['text'] as ('text' | 'image')[],
    })),
  };
}

export function makeAgyProvider(): ProviderPlugin {
  return {
    id: AGY_PROVIDER_ID,
    label: 'Google Antigravity CLI',
    docsPath: '/gateway/cli-backends',
    auth: [],
    // A successful agy models response verifies that the existing local CLI
    // session works, without importing an OAuth token into OpenClaw.
    prepareSyntheticAuth: async ({ env, signal }) => {
      const discovery = await discoverAgyModels({ env, signal });
      return discovery && hasVerifiedAgySession() ? syntheticAuth() : null;
    },
    resolveSyntheticAuth: () => hasVerifiedAgySession() ? syntheticAuth() : null,
    catalog: {
      order: 'simple',
      run: async ({ env, signal }) => {
        const discovered = await discoverAgyModels({ env, signal });
        if (!discovered) return null;
        return { provider: buildAgyProviderConfig(discovered.models) };
      },
    },
    resolveDynamicModel: ({ modelId }) => {
      if (!isAgyModelId(modelId)) return undefined;
      const meta = modelSpec({ id: modelId, name: modelId });
      return {
        id: modelId,
        name: meta.name,
        provider: AGY_PROVIDER_ID,
        api: 'google-generative-ai',
        baseUrl: 'http://antigravity.local',
        cost: meta.cost,
        reasoning: meta.reasoning,
        input: ['text'],
        contextWindow: meta.contextWindow,
        maxTokens: meta.maxTokens,
      };
    },
    isModernModelRef: ({ modelId }) => isAgyModelId(modelId),
  };
}

export function makeAgyModelCatalogProvider(): UnifiedModelCatalogProviderPlugin {
  return {
    provider: AGY_PROVIDER_ID,
    kinds: ['text'],
    liveCatalog: async ({ env, signal, timeoutMs }) => {
      const discovered = await discoverAgyModels({ env, signal, timeoutMs });
      return discovered ? toAgyCatalogRows(discovered) : null;
    },
  };
}

export function toAgyCatalogRows(
  snapshot: AgyCatalogSnapshot,
): NonNullable<Awaited<ReturnType<NonNullable<UnifiedModelCatalogProviderPlugin['liveCatalog']>>>> {
  return snapshot.models.map((model) => ({
    kind: 'text' as const,
    provider: AGY_PROVIDER_ID,
    model: model.id,
    label: model.name,
    source: snapshot.source,
    fetchedAt: snapshot.fetchedAt,
    expiresAt: snapshot.expiresAt,
    capabilities: {
      reasoning: modelSpec(model).reasoning,
      input: ['text'],
      contextWindow: modelSpec(model).contextWindow,
    },
  }));
}
