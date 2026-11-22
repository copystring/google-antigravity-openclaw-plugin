import { access, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import plugin, { prepareExactToolHome } from '../src/openclaw-plugin.js';
import { convertBundledMcpServer, prepareNormalMcpHome, refreshNormalMcpHome } from '../src/bundled-mcp-home.js';

type Prepared = {
  env?: Record<string, string>;
  cleanup?: () => Promise<void>;
  toolAvailabilityEnforced?: boolean;
};
type Backend = {
  id: string;
  config: { args: string[] };
  prepareExecution: (ctx: Record<string, unknown>) => Promise<Prepared | undefined>;
  resolveExecutionArgs: (ctx: Record<string, unknown>) => string[];
};

function backend(): Backend {
  let selected: Backend | undefined;
  plugin.register({
    registerProvider() {},
    registerModelCatalogProvider() {},
    registerCliBackend(value: unknown) {
      const candidate = value as Backend;
      if (candidate.id === 'google-antigravity-cli') selected = candidate;
    },
  } as never);
  if (!selected) throw new Error('CLI backend not registered');
  return selected;
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-mcp-test-'));
  const sourceHome = path.join(root, 'home');
  const runtime = path.join(sourceHome, '.gemini', 'antigravity-cli');
  const configDir = path.join(sourceHome, '.gemini', 'config');
  const settingsPath = path.join(root, 'openclaw-settings.json');
  await mkdir(path.join(runtime, 'conversations'), { recursive: true });
  await mkdir(path.join(runtime, 'brain'), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(path.join(sourceHome, '.ssh'), { recursive: true });
  await writeFile(path.join(runtime, 'antigravity-oauth-token'), 'fake-token');
  await writeFile(path.join(runtime, 'installation_id'), 'fake-installation');
  await writeFile(path.join(runtime, 'conversation_summaries.db'), 'fake-summaries');
  await writeFile(path.join(runtime, 'settings.json'), '{"setting":true}');
  await writeFile(path.join(runtime, 'conversations', 'resume.json'), 'resumable');
  await writeFile(path.join(runtime, 'brain', 'state.json'), 'brain-present');
  await writeFile(path.join(sourceHome, '.ssh', 'config'), 'ssh-present');
  await writeFile(path.join(configDir, 'other.json'), 'other-present');
  const manual = {
    retained: true,
    mcpServers: {
      manual: { command: 'manual-mcp' },
      openclaw: { disabled: true, serverUrl: 'https://wrong.invalid' },
    },
  };
  await writeFile(path.join(configDir, 'mcp_config.json'), JSON.stringify(manual));
  const bundled = {
    mcpServers: {
      openclaw: {
        url: 'http://127.0.0.1:4444/mcp',
        headers: { Authorization: 'Bearer ' + '$' + '{LOCAL_TOKEN}' },
        includeTools: ['get_goal', 'update_goal'],
      },
      thirdParty: {
        serverUrl: 'https://example.invalid/mcp',
        headers: { 'X-Api-Key': '$' + '{REMOTE_TOKEN}' },
      },
      stdioServer: {
        command: '/usr/bin/node',
        args: ['--flag', '$' + '{ARG_VALUE}'],
        env: { SECRET: '$' + '{REMOTE_TOKEN}' },
      },
    },
  };
  await writeFile(settingsPath, JSON.stringify(bundled));
  return {
    root, sourceHome, runtime, configDir, settingsPath, manual,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

const testEnv = { LOCAL_TOKEN: 'local-value', REMOTE_TOKEN: 'remote-value', ARG_VALUE: 'arg-value' };

describe('normal bundled MCP forwarding into agy', () => {
  it('converts all servers, merges manual config and preserves native auth, brain and resume', async () => {
    const f = await fixture();
    let home: Awaited<ReturnType<typeof prepareNormalMcpHome>>;
    try {
      home = await prepareNormalMcpHome({
        sourceHome: f.sourceHome, systemSettingsPath: f.settingsPath,
        env: testEnv, temporaryRoot: f.root,
      });
      expect(home).toBeDefined();
      const config = JSON.parse(await readFile(home!.configPath, 'utf8'));
      expect(config.retained).toBe(true);
      expect(Object.keys(config.mcpServers).sort())
        .toEqual(['manual', 'openclaw', 'thirdParty', 'stdioServer'].sort());
      expect(config.mcpServers.manual).toEqual(f.manual.mcpServers.manual);
      expect(config.mcpServers.openclaw).toEqual({
        disabled: false, serverUrl: 'http://127.0.0.1:4444/mcp',
        headers: { Authorization: 'Bearer local-value' },
        includeTools: ['get_goal', 'update_goal'],
      });
      expect(config.mcpServers.thirdParty).toEqual({
        disabled: false, serverUrl: 'https://example.invalid/mcp',
        headers: { 'X-Api-Key': 'remote-value' },
      });
      expect(config.mcpServers.stdioServer).toEqual({
        disabled: false, command: '/usr/bin/node',
        args: ['--flag', 'arg-value'], env: { SECRET: 'remote-value' },
      });
      const runtimeLink = path.join(home!.home, '.gemini', 'antigravity-cli');
      expect((await lstat(runtimeLink)).isSymbolicLink()).toBe(true);
      for (const [file, expected] of [
        ['antigravity-oauth-token', 'fake-token'],
        ['installation_id', 'fake-installation'],
        ['conversation_summaries.db', 'fake-summaries'],
        ['settings.json', '{"setting":true}'],
        ['brain/state.json', 'brain-present'],
        ['conversations/resume.json', 'resumable'],
      ]) {
        expect(await readFile(path.join(runtimeLink, file), 'utf8')).toBe(expected);
      }
      expect(await readFile(path.join(home!.home, '.ssh', 'config'), 'utf8')).toBe('ssh-present');
      expect(await readFile(path.join(home!.home, '.gemini', 'config', 'other.json'), 'utf8'))
        .toBe('other-present');
      expect(JSON.parse(await readFile(path.join(f.configDir, 'mcp_config.json'), 'utf8')))
        .toEqual(f.manual);
    } finally {
      await home?.cleanup();
      await f.cleanup();
    }
  });

  it('enables the overlay in a normal backend turn but does not affect turns without settings', async () => {
    const b = backend();
    expect(await b.prepareExecution({ modelId: 'gemini-4-neon-high', env: {} }))
      .toBeUndefined();
    const f = await fixture();
    let prepared: Prepared | undefined;
    try {
      prepared = await b.prepareExecution({
        modelId: 'gemini-4-neon-high',
        env: { ...testEnv, HOME: f.sourceHome,
          GEMINI_CLI_SYSTEM_SETTINGS_PATH: f.settingsPath },
      });
      expect(prepared?.env?.HOME).toMatch(/openclaw-antigravity-mcp-/);
      expect(prepared?.toolAvailabilityEnforced).toBeUndefined();
      const saved = JSON.parse(await readFile(path.join(
        prepared!.env!.HOME, '.gemini', 'config', 'mcp_config.json',
      ), 'utf8'));
      expect(Object.keys(saved.mcpServers).sort())
        .toEqual(['manual', 'openclaw', 'thirdParty', 'stdioServer'].sort());
    } finally {
      await prepared?.cleanup?.();
      await f.cleanup();
    }
  });

  it('accepts an empty existing native MCP config but preserves the original file', async () => {
    const f = await fixture();
    let prepared: Prepared | undefined;
    try {
      await writeFile(path.join(f.configDir, 'mcp_config.json'), '');
      prepared = await backend().prepareExecution({
        modelId: 'gemini-4-neon-high',
        env: { ...testEnv, HOME: f.sourceHome,
          GEMINI_CLI_SYSTEM_SETTINGS_PATH: f.settingsPath },
      });
      const config = JSON.parse(await readFile(path.join(
        prepared!.env!.HOME, '.gemini', 'config', 'mcp_config.json',
      ), 'utf8'));
      expect(Object.keys(config.mcpServers).sort())
        .toEqual(['openclaw', 'thirdParty', 'stdioServer'].sort());
      expect(await readFile(path.join(f.configDir, 'mcp_config.json'), 'utf8')).toBe('');
    } finally {
      await prepared?.cleanup?.();
      await f.cleanup();
    }
  });

  it('rejects broken OpenClaw MCP settings with the source path identified', async () => {
    const f = await fixture();
    try {
      await writeFile(f.settingsPath, '');
      await expect(backend().prepareExecution({
        modelId: 'gemini-4-neon-high',
        env: { HOME: f.sourceHome, GEMINI_CLI_SYSTEM_SETTINGS_PATH: f.settingsPath },
      })).rejects.toThrow('Invalid JSON in MCP settings file: ' + f.settingsPath);
    } finally {
      await f.cleanup();
    }
  });

  it('rejects malformed nonempty manual MCP config with the source path identified', async () => {
    const f = await fixture();
    const manualPath = path.join(f.configDir, 'mcp_config.json');
    try {
      await writeFile(manualPath, '{bad');
      await expect(backend().prepareExecution({
        modelId: 'gemini-4-neon-high',
        env: { ...testEnv, HOME: f.sourceHome,
          GEMINI_CLI_SYSTEM_SETTINGS_PATH: f.settingsPath },
      })).rejects.toThrow('Invalid JSON in MCP settings file: ' + manualPath);
    } finally {
      await f.cleanup();
    }
  });

  it('does not create an overlay for a settings file without MCP servers', async () => {
    const f = await fixture();
    try {
      await writeFile(f.settingsPath, JSON.stringify({ tools: { exclude: ['web'] } }));
      expect(await backend().prepareExecution({
        modelId: 'gemini-4-neon-high',
        env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: f.settingsPath },
      })).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  });

  it('preserves exact tools: only openclaw MCP is available, no unrelated server', async () => {
    const f = await fixture();
    let exact: Awaited<ReturnType<typeof prepareExactToolHome>> | undefined;
    try {
      exact = await prepareExactToolHome({
        toolAvailability: { native: [], openClaw: ['get_goal'] },
        systemSettingsPath: f.settingsPath,
        sourceHome: f.sourceHome, temporaryRoot: f.root, env: testEnv,
      });
      const config = JSON.parse(await readFile(path.join(
        exact.home, '.gemini', 'config', 'mcp_config.json',
      ), 'utf8'));
      expect(Object.keys(config.mcpServers)).toEqual(['openclaw']);
      const settings = JSON.parse(await readFile(path.join(
        exact.home, '.gemini', 'antigravity-cli', 'settings.json',
      ), 'utf8'));
      expect(settings.mcp.allowed).toEqual(['openclaw']);
      expect(settings.permissions.allow).toEqual(['mcp(openclaw/get_goal)']);
    } finally {
      await exact?.cleanup();
      await f.cleanup();
    }
  });

  it('preserves zeroTools and isolated completion without any bundled/manual MCPs', async () => {
    const f = await fixture();
    try {
      for (const isolatedCompletion of [false, true]) {
        const exact = await prepareExactToolHome({
          toolAvailability: { native: [], openClaw: [] },
          systemSettingsPath: f.settingsPath,
          sourceHome: f.sourceHome, temporaryRoot: f.root,
          isolatedCompletion,
        });
        try {
          const config = JSON.parse(await readFile(path.join(
            exact.home, '.gemini', 'config', 'mcp_config.json',
          ), 'utf8'));
          expect(config.mcpServers).toEqual({});
          const settings = JSON.parse(await readFile(path.join(
            exact.home, '.gemini', 'antigravity-cli', 'settings.json',
          ), 'utf8'));
          expect(settings.permissions.deny).toContain('mcp(*)');
          if (isolatedCompletion) {
            await expect(access(path.join(
              exact.home, '.gemini', 'antigravity-cli', 'conversations',
            ))).rejects.toThrow();
          }
        } finally {
          await exact.cleanup();
        }
      }
    } finally {
      await f.cleanup();
    }
  });

  it('refreshes the rotated OpenClaw capture header just before an agy launch', async () => {
    const f = await fixture();
    let home: Awaited<ReturnType<typeof prepareNormalMcpHome>>;
    try {
      home = await prepareNormalMcpHome({
        sourceHome: f.sourceHome, systemSettingsPath: f.settingsPath,
        env: testEnv, temporaryRoot: f.root,
      });
      const original = JSON.parse(await readFile(f.settingsPath, 'utf8'));
      original.mcpServers.openclaw.headers['x-openclaw-cli-capture-key'] = 'capture-rotation-A';
      await writeFile(f.settingsPath, JSON.stringify(original));
      await refreshNormalMcpHome({
        home: home!.home, sourceHome: home!.sourceHome,
        systemSettingsPath: f.settingsPath, env: testEnv,
      });
      const config = JSON.parse(await readFile(home!.configPath, 'utf8'));
      expect(config.mcpServers.openclaw.headers['x-openclaw-cli-capture-key'])
        .toBe('capture-rotation-A');
      expect(config.mcpServers.manual).toEqual(f.manual.mcpServers.manual);
      expect(config.mcpServers.thirdParty.headers['X-Api-Key']).toBe('remote-value');
      expect(JSON.parse(await readFile(path.join(
        f.configDir, 'mcp_config.json',
      ), 'utf8'))).toEqual(f.manual);
    } finally {
      await home?.cleanup();
      await f.cleanup();
    }
  });

  it('routes unrestricted calls through the late capture wrapper only', () => {
    const b = backend();
    const baseArgs = [b.config.args[0], '--conversation', 'native-session-id'];
    const normal = b.resolveExecutionArgs({
      useResume: true, modelId: 'gemini-4-neon-high', baseArgs,
    });
    expect(normal[0]).toMatch(/normal-cli\.js$/);
    expect(normal).toContain('native-session-id');
    const exact = b.resolveExecutionArgs({
      useResume: true, modelId: 'gemini-4-neon-high', baseArgs,
      toolAvailability: { native: [], openClaw: ['get_goal'] },
    });
    expect(exact[0]).toBe(b.config.args[0]);
    expect(exact).toContain('--no-skip-permissions');
  });

  it('preserves the /compact native control arguments', () => {
    const b = backend();
    const args = b.resolveExecutionArgs({
      controlOperation: 'compact', useResume: true,
      modelId: 'gemini-4-neon-high',
      baseArgs: [b.config.args[0], '--conversation', 'native-session-id'],
    });
    expect(args[0]).toMatch(/compact-cli\.js$/);
    expect(args).toContain('native-session-id');
  });

  it('rejects missing secrets and invalid stdio settings before creating an overlay', () => {
    expect(() => convertBundledMcpServer({
      url: 'https://example.invalid',
      headers: { Authorization: 'Bearer ' + '$' + '{AGY_MISSING_TOKEN_938}' },
    }, {})).toThrow(/AGY_MISSING_TOKEN_938/);
    expect(() => convertBundledMcpServer({ command: 'node', args: [42] }, {}))
      .toThrow(/args/);
    expect(() => convertBundledMcpServer({}, {}))
      .toThrow(/URL or stdio command/);
  });
});
