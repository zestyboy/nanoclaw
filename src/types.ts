export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
  trusted?: boolean; // Elevated privileges without being main (e.g., Brain Router)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

export interface SessionEmbeddedFile {
  label: string;
  bytes: number;
  occurrences: number;
}

export interface AgentModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface AgentUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalCostUsd: number;
  modelUsage?: Record<string, AgentModelUsage>;
  estimatedContextPercent?: number | null;
}

export interface AgentRateLimitSnapshot {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
}

export interface SessionMetrics {
  group_folder: string;
  session_id: string | null;
  transcript_bytes: number;
  embedded_document_bytes: number;
  largest_entry_bytes: number;
  top_embedded_files: SessionEmbeddedFile[];
  last_input_tokens: number | null;
  last_output_tokens: number | null;
  last_total_cost_usd: number | null;
  last_model_usage: Record<string, AgentModelUsage> | null;
  last_context_percent: number | null;
  last_rate_limit_utilization: number | null;
  rate_limit_status: string | null;
  rate_limit_type: string | null;
  rate_limit_resets_at: string | null;
  warned_thresholds: string[];
  updated_at: string;
}

export interface SessionMetricsPatch {
  session_id?: string | null;
  transcript_bytes?: number;
  embedded_document_bytes?: number;
  largest_entry_bytes?: number;
  top_embedded_files?: SessionEmbeddedFile[];
  last_input_tokens?: number | null;
  last_output_tokens?: number | null;
  last_total_cost_usd?: number | null;
  last_model_usage?: Record<string, AgentModelUsage> | null;
  last_context_percent?: number | null;
  last_rate_limit_utilization?: number | null;
  rate_limit_status?: string | null;
  rate_limit_type?: string | null;
  rate_limit_resets_at?: string | null;
  warned_thresholds?: string[];
}

// --- Channel abstraction ---

export interface SendMessageOptions {
  silent?: boolean;
}

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
