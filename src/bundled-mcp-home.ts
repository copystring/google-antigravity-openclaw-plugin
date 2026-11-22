import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

type JsonRecord = Record<string, unknown>;

export type NormalMcpHome = {
  home: string;
  sourceHome: string;
  configPath: string;
  cleanup: () => Promise<void>;
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonObject(filePath: string, allowMissing = false): Promise<JsonRecord> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
  // A user-created native MCP config may legitimately be a zero-byte placeholder.
  // Only optional native files may be treated as empty; a generated OpenClaw
  // bundle must never silently become an unconfigured MCP surface.
  if (allowMissing && text.trim().length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error('Invalid JSON in MCP settings file: ' + filePath, { cause: error });
  }
  if (!isRecord(value)) {
    throw new Error('Expected a JSON object in MCP settings file: ' + filePath);
  }
  return value;
}

function resolveTemplates(value: string, runEnv: Readonly<Record<string, string>>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z_0-9]*)\}/g, (_match, key: string) => {
    const resolved = runEnv[key] ?? process.env[key];
    if (resolved === undefined) {
      throw new Error('Bundled MCP server requires environment variable ' + key);
    }
    return resolved;
  });
}

function stringRecord(
  input: unknown,
  runEnv: Readonly<Record<string, string>>,
  property: string,
): Record<string, string> | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) throw new Error('Bundled MCP ' + property + ' must be an object');
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string') {
      throw new Error('Bundled MCP ' + property + '.' + key + ' must be a string');
    }
    Object.defineProperty(result, key, {
      value: resolveTemplates(value, runEnv),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

export function convertBundledMcpServer(
  server: JsonRecord,
  runEnv: Readonly<Record<string, string>>,
): JsonRecord {
  const url = typeof server.serverUrl === 'string'
    ? server.serverUrl
    : typeof server.url === 'string'
      ? server.url
      : typeof server.httpUrl === 'string'
        ? server.httpUrl
        : undefined;
  const command = typeof server.command === 'string' ? server.command : undefined;
  if (url && command) {
    throw new Error('Bundled MCP server cannot specify both HTTP URL and stdio command');
  }
  if (!url && !command) {
    throw new Error('Bundled MCP server must specify an HTTP URL or stdio command');
  }
  const result: JsonRecord = {
    disabled: typeof server.disabled === 'boolean' ? server.disabled : false,
  };

  if (url) {
    result.serverUrl = resolveTemplates(url, runEnv);
    const headers = stringRecord(server.headers, runEnv, 'headers');
    if (headers) result.headers = headers;
  } else {
    result.command = resolveTemplates(command!, runEnv);
    if (server.args !== undefined) {
      if (!Array.isArray(server.args) || !server.args.every((arg) => typeof arg === 'string')) {
        throw new Error('Bundled MCP stdio args must be an array of strings');
      }
      result.args = server.args.map((arg: string) => resolveTemplates(arg, runEnv));
    }
    const env = stringRecord(server.env, runEnv, 'env');
    if (env) result.env = env;
    if (typeof server.cwd === 'string') result.cwd = resolveTemplates(server.cwd, runEnv);
  }

  // Preserve only native MCP metadata; never copy unrelated Gemini settings.
  for (const key of ['trust', 'timeout', 'includeTools', 'excludeTools']) {
    const value = server[key];
    if (key === 'trust' && typeof value === 'boolean') result[key] = value;
    if (key === 'timeout' && typeof value === 'number' && Number.isFinite(value)) {
      result[key] = value;
    }
    if ((key === 'includeTools' || key === 'excludeTools') &&
        Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      result[key] = [...value];
    }
  }
  return result;
}

function serverMap(settings: JsonRecord, source: string): JsonRecord | undefined {
  if (settings.mcpServers === undefined) return undefined;
  if (!isRecord(settings.mcpServers)) {
    throw new Error(source + ' mcpServers must be an object');
  }
  return settings.mcpServers;
}

async function symlinkChildren(
  sourceDir: string,
  targetDir: string,
  excludes: ReadonlySet<string>,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(sourceDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (excludes.has(entry)) continue;
    await symlink(path.join(sourceDir, entry), path.join(targetDir, entry));
  }
}

/**
 * The Gateway rotates the bundled MCP capture header after prepareExecution.
 * Re-materialize only the private overlay file using the final child environment.
 * Never update the original user's mcp_config.json.
 */
export async function refreshNormalMcpHome(params: {
  home: string;
  sourceHome: string;
  systemSettingsPath: string;
  env: Readonly<Record<string, string>>;
}): Promise<void> {
  const settings = await readJsonObject(params.systemSettingsPath);
  const servers = serverMap(settings, 'OpenClaw');
  if (!servers || Object.keys(servers).length === 0) {
    throw new Error('Final OpenClaw MCP bundle is missing all servers');
  }
  const bundled: JsonRecord = {};
  for (const [name, value] of Object.entries(servers)) {
    if (!isRecord(value)) throw new Error('Bundled MCP server ' + name + ' must be an object');
    Object.defineProperty(bundled, name, {
      value: convertBundledMcpServer(value, params.env),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const originalConfigPath = path.join(
    params.sourceHome, '.gemini', 'config', 'mcp_config.json',
  );
  const original = await readJsonObject(originalConfigPath, true);
  const manualServers = serverMap(original, 'Antigravity') ?? {};
  const merged = { ...original, mcpServers: { ...manualServers, ...bundled } };
  const targetPath = path.join(params.home, '.gemini', 'config', 'mcp_config.json');
  await writeFile(targetPath, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Overlay only ~/.gemini/config/mcp_config.json for unrestricted CLI turns.
 * Everything else in the original HOME, including the entire mutable agy runtime,
 * stays linked to the original location so resumed conversations and /compact work.
 * This is not an isolation boundary: regular turns retain their native privileges.
 */
export async function prepareNormalMcpHome(params: {
  systemSettingsPath?: string;
  env?: Readonly<Record<string, string>>;
  sourceHome?: string;
  temporaryRoot?: string;
}): Promise<NormalMcpHome | undefined> {
  if (!params.systemSettingsPath) return undefined;

  const settings = await readJsonObject(params.systemSettingsPath);
  const bundledServers = serverMap(settings, 'OpenClaw');
  if (!bundledServers || Object.keys(bundledServers).length === 0) return undefined;

  const runEnv = params.env ?? {};
  const converted: JsonRecord = {};
  for (const [name, value] of Object.entries(bundledServers)) {
    if (!isRecord(value)) {
      throw new Error('Bundled MCP server ' + name + ' must be an object');
    }
    Object.defineProperty(converted, name, {
      value: convertBundledMcpServer(value, runEnv),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const sourceHome = path.resolve(params.sourceHome ?? runEnv.HOME ?? process.env.HOME ?? homedir());
  const sourceGemini = path.join(sourceHome, '.gemini');
  const sourceConfig = path.join(sourceGemini, 'config', 'mcp_config.json');
  const manualSettings = await readJsonObject(sourceConfig, true);
  const manualServers = serverMap(manualSettings, 'Antigravity') ?? {};
  const mergedSettings = {
    ...manualSettings,
    // OpenClaw controls name collisions, while unrelated manual servers remain.
    mcpServers: { ...manualServers, ...converted },
  };

  const home = await mkdtemp(
    path.join(params.temporaryRoot ?? tmpdir(), 'openclaw-antigravity-mcp-'),
  );
  const targetGemini = path.join(home, '.gemini');
  const targetConfig = path.join(targetGemini, 'config');
  const configPath = path.join(targetConfig, 'mcp_config.json');
  try {
    await symlinkChildren(sourceHome, home, new Set(['.gemini']));
    await mkdir(targetConfig, { recursive: true, mode: 0o700 });
    await symlinkChildren(sourceGemini, targetGemini, new Set(['config']));
    await symlinkChildren(path.join(sourceGemini, 'config'), targetConfig, new Set(['mcp_config.json']));
    await writeFile(configPath, JSON.stringify(mergedSettings, null, 2) + '\n', { mode: 0o600 });
    return {
      home,
      sourceHome,
      configPath,
      cleanup: () => rm(home, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}
