import { ContainerOutput } from './container-runner.js';
import { getSessionMetrics, upsertSessionMetrics } from './db.js';
import {
  cloneModelUsage,
  estimateContextPercent,
  inspectSessionTranscript,
} from './session-health.js';
import { SessionMetrics } from './types.js';

function normalizeResetAt(resetsAt: number | undefined): string | null {
  if (!resetsAt || !Number.isFinite(resetsAt)) return null;
  const milliseconds =
    resetsAt > 1_000_000_000_000 ? resetsAt : resetsAt * 1000;
  return new Date(milliseconds).toISOString();
}

export function refreshSessionMetrics(
  groupFolder: string,
  sessionId: string | undefined,
  output?: ContainerOutput,
): SessionMetrics | undefined {
  const patch: Parameters<typeof upsertSessionMetrics>[1] = {};

  if (sessionId !== undefined) {
    patch.session_id = sessionId;
    if (sessionId) {
      const transcript = inspectSessionTranscript(groupFolder, sessionId);
      if (transcript) {
        patch.transcript_bytes = transcript.transcriptBytes;
        patch.embedded_document_bytes = transcript.embeddedDocumentBytes;
        patch.largest_entry_bytes = transcript.largestEntryBytes;
        patch.top_embedded_files = transcript.topEmbeddedFiles;
      }
    }
  }

  if (output?.usage) {
    patch.last_input_tokens = output.usage.inputTokens;
    patch.last_output_tokens = output.usage.outputTokens;
    patch.last_total_cost_usd = output.usage.totalCostUsd;
    patch.last_model_usage = cloneModelUsage(output.usage.modelUsage);
    patch.last_context_percent =
      output.usage.estimatedContextPercent ??
      estimateContextPercent({
        inputTokens: output.usage.inputTokens,
        outputTokens: output.usage.outputTokens,
        cacheReadInputTokens: output.usage.cacheReadInputTokens,
        cacheCreationInputTokens: output.usage.cacheCreationInputTokens,
        modelUsage: output.usage.modelUsage,
      });
  }

  if (output?.rateLimitInfo) {
    patch.last_rate_limit_utilization =
      output.rateLimitInfo.utilization ?? null;
    patch.rate_limit_status = output.rateLimitInfo.status;
    patch.rate_limit_type = output.rateLimitInfo.rateLimitType ?? null;
    patch.rate_limit_resets_at = normalizeResetAt(
      output.rateLimitInfo.resetsAt,
    );
  }

  if (Object.keys(patch).length === 0) {
    return getSessionMetrics(groupFolder);
  }

  return upsertSessionMetrics(groupFolder, patch);
}
