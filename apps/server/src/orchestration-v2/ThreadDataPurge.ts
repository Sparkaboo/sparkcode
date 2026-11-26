import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * Deletes a soft-deleted thread's conversation payloads, search index rows (via triggers), and
 * historical events, while keeping the tombstone, `thread.created`, and provider runtime pointers
 * until unsettled outbox effects finish and the 1-day sync window expires.
 */
export const purgeDeletedThreadPayload = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  options?: {
    readonly keepEventsFromSequence?: number;
  },
) {
  // Triggers automatically remove matching rows from FTS5 `orchestration_v2_message_search`
  // and `orchestration_v2_projection_turn_item_counts`.
  yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId}`;
  yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}`;
  yield* sql`DELETE FROM orchestration_v2_turn_item_positions WHERE thread_id = ${threadId}`;
  yield* sql`DELETE FROM orchestration_v2_projection_plans WHERE thread_id = ${threadId}`;
  yield* sql`DELETE FROM orchestration_v2_projection_checkpoints WHERE thread_id = ${threadId}`;
  yield* sql`DELETE FROM orchestration_v2_projection_checkpoint_scopes WHERE thread_id = ${threadId}`;
  yield* sql`DELETE FROM orchestration_v2_projection_context_handoffs WHERE thread_id = ${threadId}`;
  yield* sql`
    DELETE FROM orchestration_v2_projection_context_transfers
    WHERE target_thread_id = ${threadId}
       OR (source_thread_id = ${threadId} AND status != 'pending')
  `;
  yield* sql`DELETE FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId}`;
  yield* sql`DELETE FROM orchestration_v2_projection_runtime_requests WHERE thread_id = ${threadId}`;
  yield* sql`DELETE FROM orchestration_v2_projection_nodes WHERE thread_id = ${threadId}`;
  yield* sql`DELETE FROM orchestration_v2_projection_run_attempts WHERE thread_id = ${threadId}`;
  yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}`;
  yield* sql`DELETE FROM orchestration_v2_thread_launch_workflows WHERE thread_id = ${threadId}`;
  yield* sql`DELETE FROM mcp_app_model_context WHERE thread_id = ${threadId}`;

  const deletedEvents =
    options?.keepEventsFromSequence !== undefined
      ? yield* sql<{ readonly sequence: number }>`
          DELETE FROM orchestration_events
          WHERE aggregate_kind = 'thread'
            AND stream_id = ${threadId}
            AND sequence < ${options.keepEventsFromSequence}
            AND event_type != 'thread.created'
          RETURNING sequence
        `
      : yield* sql<{ readonly sequence: number }>`
          DELETE FROM orchestration_events
          WHERE aggregate_kind = 'thread'
            AND stream_id = ${threadId}
            AND event_type NOT IN ('thread.created', 'thread.deleted')
            AND sequence < COALESCE(
              (
                SELECT MAX(sequence)
                FROM orchestration_events
                WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
              ),
              0
            )
          RETURNING sequence
        `;

  // Any kept subagent disposal event in the deletion tail must not reference a deleted prompt
  // anchor or retain prompt text.
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(json_remove(payload_json, '$.promptSequence'), '$.prompt', '')
    WHERE aggregate_kind = 'thread'
      AND stream_id = ${threadId}
      AND event_type IN ('subagent.updated', 'turn-item.updated')
      AND (
        json_type(payload_json, '$.promptSequence') = 'integer'
        OR json_extract(payload_json, '$.prompt') != ''
      )
  `;

  return { deletedEventCount: deletedEvents.length };
});

/**
 * Deletes provider runtime pointer rows for a deleted thread once no unsettled outbox effects
 * remain (e.g. `provider-session.detach` has completed).
 */
export const purgeDeletedThreadRuntimePointers = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  yield* sql`DELETE FROM orchestration_v2_projection_provider_turns WHERE thread_id = ${threadId}`;
  yield* sql`DELETE FROM orchestration_v2_projection_provider_threads WHERE thread_id = ${threadId}`;
  yield* sql`DELETE FROM orchestration_v2_projection_provider_session_bindings WHERE thread_id = ${threadId}`;
  yield* sql`
    DELETE FROM orchestration_v2_projection_provider_sessions
    WHERE thread_id = ${threadId}
      AND status = 'stopped'
      AND NOT EXISTS (
        SELECT 1
        FROM orchestration_v2_projection_provider_session_bindings AS binding
        WHERE binding.provider_session_id = orchestration_v2_projection_provider_sessions.provider_session_id
      )
  `;
  yield* sql`DELETE FROM provider_session_runtime WHERE thread_id = ${threadId}`;
});

/**
 * Permanently removes an expired soft-deleted thread tombstone and all remaining records
 * (remaining events including `thread.created` / `thread.deleted`, command receipts, settled
 * outbox entries, legacy import markers, and legacy V1 rows).
 */
export const hardDeleteExpiredThreadTombstone = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  const payload = yield* purgeDeletedThreadPayload(sql, threadId);
  yield* purgeDeletedThreadRuntimePointers(sql, threadId);
  yield* sql`
    DELETE FROM orchestration_v2_projection_context_transfers
    WHERE source_thread_id = ${threadId} OR target_thread_id = ${threadId}
  `;
  yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
  const remainingEvents = yield* sql<{ readonly sequence: number }>`
    DELETE FROM orchestration_events
    WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
    RETURNING sequence
  `;
  const deletedReceipts = yield* sql<{ readonly command_id: string }>`
    DELETE FROM orchestration_command_receipts
    WHERE aggregate_kind = 'thread' AND aggregate_id = ${threadId}
    RETURNING command_id
  `;
  yield* sql`DELETE FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId}`;
  yield* sql`DELETE FROM orchestration_v2_legacy_imports WHERE thread_id = ${threadId}`;
  // Clear matching V1 rows so `LegacyV1ThreadImporter` can never resurrect a hard-deleted thread.
  yield* sql`DELETE FROM projection_thread_messages WHERE thread_id = ${threadId}`;
  yield* sql`DELETE FROM projection_thread_sessions WHERE thread_id = ${threadId}`;
  yield* sql`DELETE FROM projection_thread_pull_requests WHERE thread_id = ${threadId}`;
  yield* sql`DELETE FROM projection_threads WHERE thread_id = ${threadId}`;
  return {
    deletedEventCount: payload.deletedEventCount + remainingEvents.length,
    deletedReceiptCount: deletedReceipts.length,
  };
});

/**
 * Permanently removes an expired soft-deleted project that has no remaining threads.
 */
export const hardDeleteExpiredProjectTombstone = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  projectId: ProjectId,
) {
  yield* sql`DELETE FROM projection_projects WHERE project_id = ${projectId}`;
  const deletedEvents = yield* sql<{ readonly sequence: number }>`
    DELETE FROM orchestration_events
    WHERE aggregate_kind = 'project' AND stream_id = ${projectId}
    RETURNING sequence
  `;
  const deletedReceipts = yield* sql<{ readonly command_id: string }>`
    DELETE FROM orchestration_command_receipts
    WHERE aggregate_kind = 'project' AND aggregate_id = ${projectId}
    RETURNING command_id
  `;
  return {
    deletedEventCount: deletedEvents.length,
    deletedReceiptCount: deletedReceipts.length,
  };
});
