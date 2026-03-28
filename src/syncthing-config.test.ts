import { describe, expect, it } from 'vitest';

import {
  buildDesiredSyncthingConfig,
  extractSyncthingApiKey,
  readSyncthingEnv,
} from './syncthing-config.js';

function baseConfig() {
  return {
    folders: [
      {
        id: 'old-folder',
        path: '/tmp/old',
        type: 'sendonly',
      },
    ],
    devices: [
      {
        deviceID: 'OLDPEER',
        name: 'Old Peer',
        addresses: ['dynamic'],
      },
    ],
    gui: {
      address: '0.0.0.0:8384',
      enabled: true,
    },
    options: {
      startBrowser: true,
      localAnnounceEnabled: false,
      globalAnnounceEnabled: false,
      relaysEnabled: false,
      natEnabled: false,
    },
    defaults: {
      folder: {
        copyOwnershipFromParent: false,
      },
      device: {
        compression: 'metadata',
      },
    },
  };
}

describe('syncthing-config', () => {
  it('reads environment with defaults', () => {
    const env = readSyncthingEnv({});

    expect(env.homeDir).toBe('/data/syncthing');
    expect(env.folderId).toBe('nanoclaw-projects');
    expect(env.folderPath).toBe('/data/projects');
    expect(env.versioningDays).toBe(30);
    expect(env.guiAddress).toBe('127.0.0.1:8384');
  });

  it('extracts the api key from config.xml', () => {
    const apiKey = extractSyncthingApiKey(
      '<configuration><gui><apikey>secret-key</apikey></gui></configuration>',
    );

    expect(apiKey).toBe('secret-key');
  });

  it('renders the projects folder and peer device', () => {
    const result = buildDesiredSyncthingConfig(baseConfig(), {
      homeDir: '/data/syncthing',
      apiBaseUrl: 'http://127.0.0.1:8384',
      folderId: 'nanoclaw-projects',
      folderPath: '/data/projects',
      peerDeviceId: 'PEERDEVICEID',
      versioningDays: 45,
      waitTimeoutMs: 30000,
      guiAddress: '127.0.0.1:8384',
    });

    expect(result.warnings).toEqual([]);
    expect(result.config.gui?.address).toBe('127.0.0.1:8384');
    expect(result.config.options?.globalAnnounceEnabled).toBe(true);
    expect(result.config.options?.localAnnounceEnabled).toBe(true);
    expect(result.config.options?.relaysEnabled).toBe(true);
    expect(result.config.options?.reconnectionIntervalS).toBe(10);
    expect(result.config.options?.stunKeepaliveStartS).toBe(25);
    expect(result.config.options?.stunKeepaliveMinS).toBe(15);
    expect(result.config.options?.relayReconnectIntervalM).toBe(5);

    const folder = result.config.folders?.find(
      (entry) => entry.id === 'nanoclaw-projects',
    );
    expect(folder).toBeDefined();
    expect(folder?.path).toBe('/data/projects');
    expect(folder?.type).toBe('sendreceive');
    expect(folder?.ignorePerms).toBe(true);
    expect(folder?.fsWatcherEnabled).toBe(true);
    expect(folder?.rescanIntervalS).toBe(60);
    expect(folder?.versioning).toMatchObject({
      type: 'staggered',
      params: { maxAge: '45' },
      cleanupIntervalS: 3600,
    });

    const peer = result.config.devices?.find(
      (entry) => entry.deviceID === 'PEERDEVICEID',
    );
    expect(peer).toBeDefined();
    expect(peer?.addresses).toEqual(['dynamic']);
  });

  it('removes the managed share when no peer is configured', () => {
    const result = buildDesiredSyncthingConfig(
      {
        ...baseConfig(),
        folders: [
          {
            id: 'nanoclaw-projects',
            path: '/data/projects',
            type: 'sendreceive',
          },
        ],
        devices: [
          {
            deviceID: 'PEERDEVICEID',
            name: 'Laptop',
          },
        ],
      },
      {
        homeDir: '/data/syncthing',
        apiBaseUrl: 'http://127.0.0.1:8384',
        folderId: 'nanoclaw-projects',
        folderPath: '/data/projects',
        peerDeviceId: undefined,
        versioningDays: 30,
        waitTimeoutMs: 30000,
        guiAddress: '127.0.0.1:8384',
      },
    );

    expect(result.config.folders).toEqual([]);
    expect(result.config.devices).toEqual([]);
    expect(result.warnings).toContain(
      'SYNCTHING_PEER_DEVICE_ID is not set; Syncthing will start without the shared projects folder.',
    );
  });
});
