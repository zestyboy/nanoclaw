/**
 * Message mirroring for project conversations.
 *
 * When the Brain Router identifies a project, it activates a mirror that causes
 * messages sent to the source channel (e.g., #personal-assistant) to also appear
 * in the project's Discord channel — both user messages and bot responses.
 */

import { logger } from './logger.js';

export interface MirrorEntry {
  sourceJid: string;
  targetJid: string;
  projectName: string;
  activatedAt: number;
  expiresAt: number;
}

export interface MessageRecord {
  jid: string;
  text: string;
  timestamp: number;
  senderName?: string;
  isUserMessage: boolean;
}

const MAX_MIRRORS_PER_SOURCE = 3;
const RING_BUFFER_SIZE = 50;
const RETROACTIVE_LOOKBACK_MS = 5 * 60 * 1000; // 5 minutes

// Active mirrors: sourceJid → MirrorEntry[]
const mirrors = new Map<string, MirrorEntry[]>();

// Ring buffer for retroactive lookback (captures both user and bot messages)
const messageBuffer: MessageRecord[] = [];

export function activateMirror(
  sourceJid: string,
  targetJid: string,
  projectName: string,
  durationMinutes?: number,
): { activated: boolean; retroactive: MessageRecord[] } {
  const durationMs = (durationMinutes ?? 30) * 60 * 1000;
  const now = Date.now();

  // Prevent mirror loops: reject if target already mirrors back to source
  const targetMirrors = mirrors.get(targetJid) || [];
  if (targetMirrors.some((e) => e.targetJid === sourceJid)) {
    logger.warn(
      { sourceJid, targetJid },
      'Mirror rejected: would create a loop',
    );
    return { activated: false, retroactive: [] };
  }

  let entries = mirrors.get(sourceJid) || [];

  // Check if this exact mirror already exists — refresh expiry
  const existing = entries.find((e) => e.targetJid === targetJid);
  if (existing) {
    existing.expiresAt = now + durationMs;
    existing.activatedAt = now;
    logger.info({ sourceJid, targetJid, projectName }, 'Mirror refreshed');
  } else {
    // Enforce max mirrors per source
    if (entries.length >= MAX_MIRRORS_PER_SOURCE) {
      entries.sort((a, b) => a.activatedAt - b.activatedAt);
      const removed = entries.shift()!;
      logger.info(
        { sourceJid, removedTarget: removed.targetJid },
        'Evicted oldest mirror',
      );
    }

    entries.push({
      sourceJid,
      targetJid,
      projectName,
      activatedAt: now,
      expiresAt: now + durationMs,
    });
    mirrors.set(sourceJid, entries);
    logger.info(
      {
        sourceJid,
        targetJid,
        projectName,
        durationMinutes: durationMinutes || 30,
      },
      'Mirror activated',
    );
  }

  // Collect retroactive messages from the ring buffer
  const cutoff = now - RETROACTIVE_LOOKBACK_MS;
  const retroactive = messageBuffer.filter(
    (r) => r.jid === sourceJid && r.timestamp >= cutoff,
  );

  return { activated: true, retroactive };
}

export function deactivateMirror(
  sourceJid: string,
  targetJid?: string,
): boolean {
  if (targetJid) {
    const entries = mirrors.get(sourceJid);
    if (!entries) return false;
    const idx = entries.findIndex((e) => e.targetJid === targetJid);
    if (idx === -1) return false;
    entries.splice(idx, 1);
    if (entries.length === 0) mirrors.delete(sourceJid);
    logger.info({ sourceJid, targetJid }, 'Mirror deactivated');
    return true;
  } else {
    const had = mirrors.has(sourceJid);
    mirrors.delete(sourceJid);
    if (had) logger.info({ sourceJid }, 'All mirrors deactivated for source');
    return had;
  }
}

export function getMirrorsForSource(sourceJid: string): MirrorEntry[] {
  const entries = mirrors.get(sourceJid);
  if (!entries) return [];

  const now = Date.now();
  const active = entries.filter((e) => e.expiresAt > now);
  if (active.length !== entries.length) {
    if (active.length === 0) {
      mirrors.delete(sourceJid);
    } else {
      mirrors.set(sourceJid, active);
    }
  }
  return active;
}

/**
 * Record a bot outbound message in the ring buffer.
 * Called when the bot sends a message to any channel.
 */
export function recordOutbound(jid: string, text: string): void {
  messageBuffer.push({
    jid,
    text,
    timestamp: Date.now(),
    isUserMessage: false,
  });
  while (messageBuffer.length > RING_BUFFER_SIZE) {
    messageBuffer.shift();
  }
}

/**
 * Record a user inbound message in the ring buffer.
 * Called when a user message arrives in a registered group.
 */
export function recordInbound(
  jid: string,
  text: string,
  senderName: string,
): void {
  messageBuffer.push({
    jid,
    text,
    timestamp: Date.now(),
    senderName,
    isUserMessage: true,
  });
  while (messageBuffer.length > RING_BUFFER_SIZE) {
    messageBuffer.shift();
  }
}

/**
 * Format retroactive messages into a single catch-up message.
 */
export function formatRetroactiveMessages(records: MessageRecord[]): string {
  if (records.length === 0) return '';

  const lines: string[] = [];
  for (const record of records) {
    if (record.isUserMessage && record.senderName) {
      lines.push(`**${record.senderName}**: ${record.text}`);
    } else {
      lines.push(record.text);
    }
  }

  return `_Catching up — recent messages about this project:_\n\n${lines.join('\n\n')}`;
}

export function cleanupExpiredMirrors(): number {
  const now = Date.now();
  let cleaned = 0;
  for (const [sourceJid, entries] of mirrors) {
    const active = entries.filter((e) => e.expiresAt > now);
    if (active.length !== entries.length) {
      cleaned += entries.length - active.length;
      if (active.length === 0) {
        mirrors.delete(sourceJid);
      } else {
        mirrors.set(sourceJid, active);
      }
    }
  }
  if (cleaned > 0) {
    logger.debug({ cleaned }, 'Cleaned up expired mirrors');
  }
  return cleaned;
}

/** @internal — exported for testing */
export function _clearAllMirrors(): void {
  mirrors.clear();
  messageBuffer.length = 0;
}

/** @internal — exported for testing */
export function _getActiveMirrorCount(): number {
  let count = 0;
  for (const entries of mirrors.values()) {
    count += entries.length;
  }
  return count;
}
