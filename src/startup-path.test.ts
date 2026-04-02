/**
 * Tests that the IS_RAILWAY flag correctly gates the credential system:
 * - Railway: OneCLI is NOT initialized (credential proxy handles credentials)
 * - Local: OneCLI IS initialized (no credential proxy needed)
 *
 * These tests catch the regression where an upstream merge removed the
 * credential proxy startup, leaving Railway agents with no API credentials.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared mock tracker
const mockOneCLIConstructor = vi.fn();

// These top-level mocks apply to all dynamic imports below
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    constructor(opts: unknown) {
      mockOneCLIConstructor(opts);
    }
    applyContainerConfig = vi.fn().mockResolvedValue(true);
    ensureAgent = vi.fn().mockResolvedValue({ created: true });
  },
}));

vi.mock('./credential-proxy.js', () => ({
  startCredentialProxy: vi.fn().mockResolvedValue({ close: vi.fn() }),
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false, mtimeMs: 0 })),
      cpSync: vi.fn(),
    },
  };
});

vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'container',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (f: string) => `/tmp/groups/${f}`,
  resolveGroupIpcPath: (f: string) => `/tmp/ipc/${f}`,
  resolveGroupSessionPath: (f: string) => `/tmp/sessions/${f}`,
}));

const CONFIG_BASE = {
  ASSISTANT_NAME: 'Andy',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/test-data',
  GROUPS_DIR: '/tmp/test-groups',
  IDLE_TIMEOUT: 1800000,
  ONECLI_URL: 'http://localhost:10254',
  PROJECTS_DIR: '/tmp/test-projects',
  PUBLIC_KNOWLEDGE_DIR: '/tmp/test-knowledge',
  SECOND_BRAIN_DIR: '',
  TIMEZONE: 'UTC',
};

describe('IS_RAILWAY startup path gating', () => {
  beforeEach(() => {
    vi.resetModules();
    mockOneCLIConstructor.mockClear();
  });

  it('does NOT instantiate OneCLI when IS_RAILWAY is true', async () => {
    vi.doMock('./config.js', () => ({
      ...CONFIG_BASE,
      IS_RAILWAY: true,
    }));

    await import('./container-runner.js');

    expect(mockOneCLIConstructor).not.toHaveBeenCalled();
  });

  it('instantiates OneCLI when IS_RAILWAY is false', async () => {
    vi.doMock('./config.js', () => ({
      ...CONFIG_BASE,
      IS_RAILWAY: false,
    }));

    await import('./container-runner.js');

    expect(mockOneCLIConstructor).toHaveBeenCalledWith({
      url: 'http://localhost:10254',
    });
  });
});
