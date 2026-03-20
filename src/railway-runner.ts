/**
 * Railway Runner for NanoClaw
 * Replaces container-runner on Railway — spawns agents as Node.js child processes
 * instead of Docker containers (Railway can't run Docker-in-Docker).
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  IDLE_TIMEOUT,
  PUBLIC_KNOWLEDGE_DIR,
  PROJECTS_DIR,
  RAILWAY_DATA_DIR,
  SECOND_BRAIN_DIR,
  TIMEZONE,
} from './config.js';
import { ContainerInput, ContainerOutput } from './container-runner.js';
import { detectAuthMode } from './credential-proxy.js';
import { isProjectFolder, projectSlug } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

const AGENT_RUNNER_PATH =
  process.env.AGENT_RUNNER_PATH || '/agent-runner-dist/index.js';

function prepareWorkspaceDirs(
  group: RegisteredGroup,
  isMain: boolean,
  isTrusted: boolean = false,
): {
  groupDir: string;
  globalDir: string;
  sessionDir: string;
  ipcDir: string;
  env: Record<string, string>;
} {
  const dataDir = RAILWAY_DATA_DIR;
  const groupDir = isProjectFolder(group.folder)
    ? path.join(PROJECTS_DIR, projectSlug(group.folder))
    : path.join(dataDir, 'groups', group.folder);
  const globalDir = path.join(dataDir, 'groups', 'global');
  const fsName = group.folder.replace(/:/g, '_');
  const sessionDir = path.join(dataDir, 'sessions', fsName);
  const ipcDir = path.join(dataDir, 'ipc', fsName);
  const claudeDir = path.join(sessionDir, '.claude');

  // Create all required directories
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });

  // Write settings.json if not present
  const settingsFile = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into session's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(claudeDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Copy agent-runner source into per-group location
  const agentRunnerSrc = path.join(
    process.cwd(),
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(sessionDir, 'agent-runner-src');
  if (!fs.existsSync(groupAgentRunnerDir) && fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }

  // Build environment variables (replaces container mounts)
  const env: Record<string, string> = {
    NANOCLAW_WORKSPACE_GROUP: groupDir,
    NANOCLAW_WORKSPACE_GLOBAL: globalDir,
    NANOCLAW_IPC_DIR: ipcDir,
    TZ: TIMEZONE,
  };

  // Public knowledge vault
  if (PUBLIC_KNOWLEDGE_DIR && fs.existsSync(PUBLIC_KNOWLEDGE_DIR)) {
    env.NANOCLAW_WORKSPACE_PUBLIC_KNOWLEDGE = PUBLIC_KNOWLEDGE_DIR;
  }

  // Second Brain vault
  if (SECOND_BRAIN_DIR && fs.existsSync(SECOND_BRAIN_DIR)) {
    env.NANOCLAW_WORKSPACE_SECOND_BRAIN = SECOND_BRAIN_DIR;
  }

  // Credential proxy — agents route ALL API calls through it.
  // OAuth mode: proxy replaces placeholder Bearer with real token.
  // Must use placeholder so Claude Code doesn't try direct OAuth calls.
  const authMode = detectAuthMode();
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${CREDENTIAL_PROXY_PORT}`;
  if (authMode === 'api-key') {
    env.ANTHROPIC_API_KEY = 'placeholder';
  } else {
    env.CLAUDE_CODE_OAUTH_TOKEN = 'placeholder';
  }

  if (isMain || isTrusted) {
    // Elevated groups get access to all groups and projects dirs
    env.NANOCLAW_WORKSPACE_ALL_GROUPS = path.join(dataDir, 'groups');
    const projectsDir = path.join(dataDir, 'projects');
    if (fs.existsSync(projectsDir)) {
      env.NANOCLAW_WORKSPACE_PROJECTS = projectsDir;
    }
  }

  return { groupDir, globalDir, sessionDir, ipcDir, env };
}

export async function runRailwayAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const isMain = input.isMain;

  const isTrusted = input.isTrusted === true;
  const { groupDir, sessionDir, env } = prepareWorkspaceDirs(
    group,
    isMain,
    isTrusted,
  );

  const processName = `railway-${group.folder.replace(/[^a-zA-Z0-9-]/g, '-')}-${Date.now()}`;

  logger.info(
    {
      group: group.name,
      processName,
      isMain,
    },
    'Spawning Railway agent (child process)',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const child = spawn('node', [AGENT_RUNNER_PATH], {
      env: {
        ...process.env,
        ...env,
        HOME: sessionDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(child, processName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Railway agent timeout, sending SIGTERM',
      );
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          logger.warn(
            { group: group.name, processName },
            'Graceful stop failed, force killing',
          );
          child.kill('SIGKILL');
        }
      }, 15000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    child.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Railway agent stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ process: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
      } else {
        stderr += chunk;
      }
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `railway-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Railway Agent Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Process: ${processName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, processName, duration, code },
            'Railway agent timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, processName, duration, code },
          'Railway agent timed out with no output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Railway agent timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `railway-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Railway Agent Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Stderr ===`,
          stderr,
          ``,
          `=== Stdout ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug(
        { logFile, verbose: isVerbose },
        'Railway agent log written',
      );

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Railway agent exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Railway agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Railway agent completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Railway agent completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse Railway agent output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, processName, error: err },
        'Railway agent spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Spawn error: ${err.message}`,
      });
    });
  });
}
