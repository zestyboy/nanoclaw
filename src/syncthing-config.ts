import fs from 'fs';
import path from 'path';

export interface SyncthingEnv {
  homeDir: string;
  apiBaseUrl: string;
  folderId: string;
  folderPath: string;
  peerDeviceId?: string;
  versioningDays: number;
  waitTimeoutMs: number;
  guiAddress: string;
}

export interface SyncthingConfigResponse {
  folders?: SyncthingFolder[];
  devices?: SyncthingDevice[];
  gui?: Record<string, unknown>;
  options?: Record<string, unknown>;
  defaults?: {
    folder?: Record<string, unknown>;
    device?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

export interface SyncthingDevice {
  deviceID?: string;
  name?: string;
  addresses?: string[];
  [key: string]: unknown;
}

export interface SyncthingFolder {
  id?: string;
  label?: string;
  path?: string;
  type?: string;
  rescanIntervalS?: number;
  fsWatcherEnabled?: boolean;
  fsWatcherDelayS?: number;
  ignorePerms?: boolean;
  devices?: Array<Record<string, unknown>>;
  versioning?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BuildSyncthingConfigResult {
  config: SyncthingConfigResponse;
  warnings: string[];
}

const DEFAULT_HOME_DIR = '/data/syncthing';
const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8384';
const DEFAULT_FOLDER_ID = 'nanoclaw-projects';
const DEFAULT_FOLDER_PATH = '/data/projects';
const DEFAULT_VERSIONING_DAYS = 30;
const DEFAULT_WAIT_TIMEOUT_MS = 30000;
const DEFAULT_GUI_ADDRESS = '127.0.0.1:8384';

function parsePositiveInteger(
  rawValue: string | undefined,
  fallback: number,
): number {
  if (!rawValue) return fallback;
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function uniqueArray<T>(values: T[], getKey: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const key = getKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function readSyncthingEnv(
  env: NodeJS.ProcessEnv = process.env,
): SyncthingEnv {
  return {
    homeDir: env.SYNCTHING_HOME_DIR || DEFAULT_HOME_DIR,
    apiBaseUrl: env.SYNCTHING_API_BASE_URL || DEFAULT_API_BASE_URL,
    folderId: env.SYNCTHING_FOLDER_ID || DEFAULT_FOLDER_ID,
    folderPath: env.SYNCTHING_FOLDER_PATH || DEFAULT_FOLDER_PATH,
    peerDeviceId: env.SYNCTHING_PEER_DEVICE_ID?.trim() || undefined,
    versioningDays: parsePositiveInteger(
      env.SYNCTHING_VERSIONING_DAYS,
      DEFAULT_VERSIONING_DAYS,
    ),
    waitTimeoutMs: parsePositiveInteger(
      env.SYNCTHING_WAIT_TIMEOUT_MS,
      DEFAULT_WAIT_TIMEOUT_MS,
    ),
    guiAddress: env.SYNCTHING_GUI_ADDRESS || DEFAULT_GUI_ADDRESS,
  };
}

export function extractSyncthingApiKey(configXml: string): string | undefined {
  const match = configXml.match(/<apikey>([^<]+)<\/apikey>/i);
  return match?.[1]?.trim() || undefined;
}

function buildPeerDevice(
  defaultDevice: Record<string, unknown> | undefined,
  peerDeviceId: string,
): SyncthingDevice {
  const device = cloneJson(defaultDevice || {});
  return {
    ...device,
    deviceID: peerDeviceId,
    name:
      typeof device.name === 'string' && device.name.trim()
        ? device.name
        : 'NanoClaw Laptop',
    addresses: ['dynamic'],
    paused: false,
    autoAcceptFolders: false,
    introducer: false,
    skipIntroductionRemovals: false,
  };
}

function buildProjectsFolder(
  defaultFolder: Record<string, unknown> | undefined,
  env: SyncthingEnv,
): SyncthingFolder {
  const folder = cloneJson(defaultFolder || {});
  const versioning = cloneJson(
    (folder.versioning as Record<string, unknown> | undefined) || {},
  );
  const params = cloneJson(
    (versioning.params as Record<string, unknown> | undefined) || {},
  );

  params.maxAge = String(env.versioningDays);

  return {
    ...folder,
    id: env.folderId,
    label: 'NanoClaw Projects',
    path: env.folderPath,
    type: 'sendreceive',
    rescanIntervalS: 60,
    fsWatcherEnabled: true,
    fsWatcherDelayS: 10,
    ignorePerms: true,
    devices: [{ deviceID: env.peerDeviceId, introducedBy: '' }],
    versioning: {
      ...versioning,
      type: 'staggered',
      params,
      cleanupIntervalS: 3600,
    },
  };
}

export function buildDesiredSyncthingConfig(
  current: SyncthingConfigResponse,
  env: SyncthingEnv,
): BuildSyncthingConfigResult {
  const warnings: string[] = [];
  const config = cloneJson(current);
  const existingDevices = Array.isArray(config.devices) ? config.devices : [];
  const existingFolders = Array.isArray(config.folders) ? config.folders : [];
  const defaultDevice = config.defaults?.device;
  const defaultFolder = config.defaults?.folder;

  config.gui = {
    ...(config.gui || {}),
    enabled: true,
    address: env.guiAddress,
  };

  config.options = {
    ...(config.options || {}),
    startBrowser: false,
    localAnnounceEnabled: true,
    globalAnnounceEnabled: true,
    relaysEnabled: true,
    natEnabled: true,
    reconnectionIntervalS: 10,
    stunKeepaliveStartS: 25,
    stunKeepaliveMinS: 15,
    relayReconnectIntervalM: 5,
  };

  const devices = existingDevices.filter(
    (device) => device.deviceID !== env.peerDeviceId,
  );
  const folders = existingFolders.filter(
    (folder) => folder.id !== env.folderId,
  );

  if (env.peerDeviceId) {
    devices.push(buildPeerDevice(defaultDevice, env.peerDeviceId));
    folders.push(buildProjectsFolder(defaultFolder, env));
  } else {
    warnings.push(
      'SYNCTHING_PEER_DEVICE_ID is not set; Syncthing will start without the shared projects folder.',
    );
  }

  const referencedDeviceIds = new Set(
    folders.flatMap((folder) =>
      Array.isArray(folder.devices)
        ? folder.devices
            .map((device) =>
              typeof device.deviceID === 'string' ? device.deviceID : '',
            )
            .filter(Boolean)
        : [],
    ),
  );

  config.devices = uniqueArray(
    devices.filter(
      (device) =>
        typeof device.deviceID !== 'string' ||
        referencedDeviceIds.has(device.deviceID),
    ),
    (device) => device.deviceID || '',
  );
  config.folders = uniqueArray(folders, (folder) => folder.id || '');

  return { config, warnings };
}

async function waitForRestApi(
  apiBaseUrl: string,
  apiKey: string,
  waitTimeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + waitTimeoutMs;
  let lastError = 'unknown error';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiBaseUrl}/rest/system/version`, {
        headers: { 'X-API-Key': apiKey },
      });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Syncthing API did not become ready: ${lastError}`);
}

async function getRestConfig(
  apiBaseUrl: string,
  apiKey: string,
): Promise<SyncthingConfigResponse> {
  const response = await fetch(`${apiBaseUrl}/rest/config`, {
    headers: { 'X-API-Key': apiKey },
  });
  if (!response.ok) {
    throw new Error(`Failed to read Syncthing config: HTTP ${response.status}`);
  }
  return (await response.json()) as SyncthingConfigResponse;
}

async function putRestConfig(
  apiBaseUrl: string,
  apiKey: string,
  config: SyncthingConfigResponse,
): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/rest/config`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to update Syncthing config: HTTP ${response.status}`,
    );
  }
}

async function restartSyncthing(
  apiBaseUrl: string,
  apiKey: string,
): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/rest/system/restart`, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey },
  });
  if (!response.ok) {
    throw new Error(`Failed to restart Syncthing: HTTP ${response.status}`);
  }
}

export async function configureSyncthingFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BuildSyncthingConfigResult> {
  const settings = readSyncthingEnv(env);
  const configPath = path.join(settings.homeDir, 'config.xml');
  const configXml = fs.readFileSync(configPath, 'utf-8');
  const apiKey = extractSyncthingApiKey(configXml);
  if (!apiKey) {
    throw new Error(`Syncthing API key not found in ${configPath}`);
  }

  await waitForRestApi(settings.apiBaseUrl, apiKey, settings.waitTimeoutMs);

  const current = await getRestConfig(settings.apiBaseUrl, apiKey);
  const next = buildDesiredSyncthingConfig(current, settings);
  const currentJson = JSON.stringify(current);
  const nextJson = JSON.stringify(next.config);

  if (currentJson !== nextJson) {
    await putRestConfig(settings.apiBaseUrl, apiKey, next.config);
    await restartSyncthing(settings.apiBaseUrl, apiKey);
  }

  return next;
}

async function main(): Promise<void> {
  const result = await configureSyncthingFromEnv();
  for (const warning of result.warnings) {
    console.warn(`Syncthing: ${warning}`);
  }
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Syncthing: ${message}`);
    process.exit(1);
  });
}
