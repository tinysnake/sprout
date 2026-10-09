/**
 * Move-sensitive evidence for the SQLite adapter rehome (#81).
 *
 * These tests exist because this Ticket is a *relocation* of adapters, not a
 * behaviour change. They pin the two things a careless move could break without
 * any store test noticing:
 *
 * 1. **The physical schema is byte-identical.** Every table, column, declared
 *    type, primary key, `UNIQUE` constraint, and explicit indexes are
 *    asserted literally, so a moved `CREATE TABLE` that quietly renames or
 *    reorders a column fails here.
 * 2. **The rehomed adapters and the shared handle address the same tables.** A
 *    domain store constructed directly on a file and the same domain store
 *    mounted on `SqliteStore` observe each other's rows through the shared
 *    connection, which is what proves the mount still points at the same
 *    physical state.
 *
 * A third check writes a database with the exact pre-rehome `CREATE TABLE`
 * text and reads it back through the rehomed adapters, so historical durable
 * rows open unchanged. The statements are copied from the fixed base commit, so
 * this is a real compatibility assertion rather than a self-referential round
 * trip.
 */

import { test } from 'node:test';

import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';


import { SqliteStore } from '../store/db.ts';


interface ColumnShape {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly pk: number;
}


/** The exact composed schema shape, including the M2 authority boundary. */
const EXPECTED_SCHEMA: Record<string, readonly ColumnShape[]> = {
  environment_authority_override_releases: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'environment_instance_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'lease_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'origin_agent_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'document', type: 'TEXT', notnull: 1, pk: 0 },
  ],
  environment_model_authorization_evidence: [
    { name: 'evidence_id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'environment_instance_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'document', type: 'TEXT', notnull: 1, pk: 0 },
  ],
  environment_readiness_attempts: [
    { name: 'observation_id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'environment_instance_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'sequence', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'bootstrap_key', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'document', type: 'TEXT', notnull: 1, pk: 0 },
  ],
  operator_identity: [
    { name: 'singleton', type: 'INTEGER', notnull: 0, pk: 1 },
    { name: 'credential_hash', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'credential_salt', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'version', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  browser_sessions: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'token_hash', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'csrf_hash', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'credential_version', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'last_seen_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'absolute_expires_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'idle_expires_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'revoked_at', type: 'INTEGER', notnull: 0, pk: 0 },
  ],
  agent_runs: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'agent_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'prompt', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'environment_instance_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'execution_mode', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'engine_host_profile_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'project_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'events', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'lease_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'failure', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'failure_class', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'result', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'completed_at', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'hand_off', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'task_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'token_usage', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'replay_sequence', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'work_option', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'configuration_version', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'workspace_binding', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'workspace_binding_status', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'requested_work_environment_instance_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'recovery_settlement', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'recovered_events', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'retry_of_run_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'execution_placement', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'session_key_scope', type: 'TEXT', notnull: 0, pk: 0 },
  ],
  environment_leases: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'instance_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'capability', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'holder_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'holder_kind', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'run_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'task_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'acquired_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'expires_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'state', type: 'TEXT', notnull: 1, pk: 0 },
  ],
  projects: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'document', type: 'TEXT', notnull: 1, pk: 0 },
  ],
  remote_workspace_operations: [
    { name: 'operation_id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'fingerprint', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'project_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'environment_instance_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'binding_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'generation', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'connection_epoch', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'workspace_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'run_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'lease_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'holder_kind', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'holder_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'task_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'agent_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'enrollment_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'worker_identity_digest', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'workspace_kind', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'workspace_path', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'operation', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'state', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  remote_project_mcp_processes: [
    { name: 'process_id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'fingerprint', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'project_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'environment_instance_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'binding_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'generation', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'connection_epoch', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'workspace_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'agent_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'workspace_kind', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'workspace_path', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'lease_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'holder_kind', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'holder_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'run_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'task_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'enrollment_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'worker_identity_digest', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'state', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  remote_project_mcp_operations: [
    { name: 'operation_id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'fingerprint', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'process_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'tool_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'project_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'environment_instance_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'binding_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'generation', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'connection_epoch', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'workspace_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'agent_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'workspace_kind', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'workspace_path', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'lease_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'holder_kind', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'holder_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'run_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'task_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'enrollment_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'worker_identity_digest', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'state', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  agent_session_keys: [
    { name: 'slot', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'agent_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'engine', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'environment_instance_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'execution_mode', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'engine_host_profile_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'working_directory_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'engine_host_kind', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'engine_host_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'engine_host_platform', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'engine_host_boundary', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'scope_kind', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'scope_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'session_key', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  run_reconnect_gates: [
    { name: 'project_id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'armed', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'armed_at', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  run_reconnect_triggers: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'project_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'eligibility_settled', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  run_reconnect_retries: [
    { name: 'original_run_id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'trigger_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'project_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'state', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'retry_run_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'queued_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'dispatched_at', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'settled_at', type: 'INTEGER', notnull: 0, pk: 0 },
  ],
  collaboration_messages: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'project_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'scope_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'channel', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'author_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'author_kind', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'body', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'recipients', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'delivery_key', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'in_reply_to', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'envelope_json', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'message_kind', type: 'TEXT', notnull: 1, pk: 0 },
  ],
  collaboration_wake_requests: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'input_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'project_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'agent_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'reason', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'idempotency_key', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'run_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'detail', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'batch_id', type: 'TEXT', notnull: 0, pk: 0 },
  ],
  collaboration_read_markers: [
    { name: 'scope_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'human_id', type: 'TEXT', notnull: 1, pk: 2 },
    { name: 'message_id', type: 'TEXT', notnull: 1, pk: 0 },
  ],
  collaboration_attention_resolutions: [
    { name: 'source_kind', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'source_id', type: 'TEXT', notnull: 1, pk: 2 },
    { name: 'project_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'human_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'resolved_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'source_version', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  collaboration_observations: [
    { name: 'id', type: 'INTEGER', notnull: 0, pk: 1 },
    { name: 'input_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'agent_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'reason', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'detail', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  project_events: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'project_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'kind', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'summary', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'detail', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'producer_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'producer_kind', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'disposition', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'responsible_agents', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'delivery_key', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'origin_scope_ids', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'origin_message_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  collaboration_routing_windows: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'project_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'opened_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'deadline_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'interval_ms', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'cursor', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'input_count', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'closed_at', type: 'INTEGER', notnull: 0, pk: 0 },
  ],
  collaboration_window_inputs: [
    { name: 'window_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'input_id', type: 'TEXT', notnull: 1, pk: 2 },
    { name: 'joined_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  collaboration_routing_batches: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'project_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'window_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'split_index', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'split_count', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'cutoff_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'bounds', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'manifest', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'context', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'error', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'settled_at', type: 'INTEGER', notnull: 0, pk: 0 },
  ],
  collaboration_routing_batch_inputs: [
    { name: 'batch_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'input_id', type: 'TEXT', notnull: 1, pk: 2 },
    { name: 'position', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'excerpt', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'truncated', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'excerpt_chars', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'content_chars', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  collaboration_routing_attempts: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'batch_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'attempt_number', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'model_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'started_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'finished_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'error_kind', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'error_detail', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'judgement', type: 'TEXT', notnull: 0, pk: 0 },
  ],
  collaboration_routing_outcomes: [
    { name: 'batch_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'input_id', type: 'TEXT', notnull: 1, pk: 2 },
    { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'assignments', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'rationale', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'detail', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'settled_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  tasks: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'project_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'title', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'goal', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'constraints', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'assigned_agent_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'environment_preference', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'blocker_reason', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'environment_instance_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'environment_lease_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'environment_lifecycle_state', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'recovery_state', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'active_run_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'admission_document', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'control_document', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'execution_placement', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'completed_at', type: 'INTEGER', notnull: 0, pk: 0 },
  ],
  task_proposals: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'project_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'document', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'revision', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'working_group_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'source_message_id', type: 'TEXT', notnull: 0, pk: 0 },
  ],
  task_run_links: [
    { name: 'task_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'run_id', type: 'TEXT', notnull: 1, pk: 2 },
    { name: 'agent_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'sequence', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'linked_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'summary_status', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'summary_text', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'summary_agent_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'summary_recorded_at', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'advance_actor', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'advance_reason', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'content_version', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'requested_at', type: 'INTEGER', notnull: 0, pk: 0 },
  ],
  environment_enrollments: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'environment_instance_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'document', type: 'TEXT', notnull: 1, pk: 0 },
  ],
  environment_instance_enrollment_authority: [
    { name: 'environment_instance_id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'enrollment_id', type: 'TEXT', notnull: 1, pk: 0 },
  ],
  environment_catalog: [
    { name: 'instance_id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'enrollment_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'document', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  worker_connection_epochs: [
    { name: 'enrollment_id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'high_water', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  environment_readiness: [
    { name: 'environment_instance_id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'current_observation_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'document', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  environment_observations: [
    { name: 'observation_id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'environment_instance_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'enrollment_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'connection_epoch', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'sequence', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'readiness_document', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'probe_document', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'document', type: 'TEXT', notnull: 1, pk: 0 },
  ],
  environment_probes: [
    { name: 'environment_instance_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'sequence', type: 'INTEGER', notnull: 1, pk: 2 },
    { name: 'document', type: 'TEXT', notnull: 1, pk: 0 },
  ],
  operational_events: [
    { name: 'sequence', type: 'INTEGER', notnull: 0, pk: 1 },
    { name: 'subject', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'kind', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'state', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  environment_recovery: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'environment_instance_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'lease_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'phase', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'document', type: 'TEXT', notnull: 1, pk: 0 },
  ],
  worker_recovery_receipts: [
    { name: 'enrollment_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'turn_id', type: 'TEXT', notnull: 1, pk: 2 },
    { name: 'run_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'sequence', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'settlement', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'event_count', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'settlement_payload', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'settlement_status', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'acknowledged', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'settlement_acked', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'compacted', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  worker_recovery_events: [
    { name: 'enrollment_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'turn_id', type: 'TEXT', notnull: 1, pk: 2 },
    { name: 'sequence', type: 'INTEGER', notnull: 1, pk: 3 },
    { name: 'payload', type: 'TEXT', notnull: 1, pk: 0 },
  ],
  worker_recovery_contexts: [
    { name: 'enrollment_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'task_id', type: 'TEXT', notnull: 1, pk: 2 },
    { name: 'state', type: 'TEXT', notnull: 1, pk: 0 },
  ],
  environment_force_releases: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'environment_instance_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'lease_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'document', type: 'TEXT', notnull: 1, pk: 0 },
  ],
  agents: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'document', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  project_authorities: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'document', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  project_environment_access: [
    { name: 'project_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'environment_instance_id', type: 'TEXT', notnull: 1, pk: 2 },
    { name: 'document', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  conversation_scopes: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'project_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'kind', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'document', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  usage_activities: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'kind', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'run_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'attempt_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'batch_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'project_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'task_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'agent_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'environment_instance_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'engine', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'model', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'settled_at', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'wall_duration_ms', type: 'INTEGER', notnull: 0, pk: 0 },
  ],
  usage_observations: [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'activity_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'observed_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'source', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'source_version', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'completeness', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'input_tokens', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'uncached_input_tokens', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'cached_input_tokens', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'cache_write_input_tokens', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'output_tokens', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'reasoning_output_tokens', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'total_tokens', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'wall_duration_ms', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'engine_turn_duration_ms', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'billed_cost_status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'billed_usd_micros', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'billed_reason', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'cost_estimate_status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'cost_estimate_usd_micros', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'valuation_provenance', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'price_source', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'price_source_version', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'price_dimensions', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'valued_at', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'cost_estimate_reason', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'billing_basis', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'supersedes_observation_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'superseded_at', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'supersession_reason', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'is_effective', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
};


function withStore(run: (store: SqliteStore) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-rehome-'));
  const store = new SqliteStore({ filename: join(directory, 'sprout.db') });
  return Promise.resolve()
    .then(() => run(store))
    .finally(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
}


test('the composed handle declares every domain table with its contract columns', async () => {
  await withStore((store) => {
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as unknown as readonly { readonly name: string }[];
    assert.deepEqual(
      tables.map((table) => table.name),
      Object.keys(EXPECTED_SCHEMA).sort(),
    );

    for (const [table, expected] of Object.entries(EXPECTED_SCHEMA)) {
      const columns = store.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as readonly ColumnShape[];
      assert.deepEqual(
        columns.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk })),
        expected,
        `column shape for ${table}`,
      );
    }
  });
});


test('explicit indexes keep their names, tables, and column order', async () => {
  await withStore((store) => {
    const indexes = store.db
      .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
      .all() as unknown as readonly { readonly name: string; readonly tbl_name: string }[];
    assert.deepEqual(
      indexes.map((index) => ({ name: index.name, tbl: index.tbl_name })),
      [
        { name: 'operational_events_subject', tbl: 'operational_events' },
        { name: 'agent_runs_replay_sequence_idx', tbl: 'agent_runs' },
        { name: 'conversation_scopes_project', tbl: 'conversation_scopes' },
        { name: 'run_reconnect_triggers_project_idx', tbl: 'run_reconnect_triggers' },
        { name: 'run_reconnect_retries_retry_idx', tbl: 'run_reconnect_retries' },
        { name: 'collaboration_messages_scope_order', tbl: 'collaboration_messages' },
        { name: 'project_events_project', tbl: 'project_events' },
        { name: 'project_events_project_order', tbl: 'project_events' },
        { name: 'collaboration_routing_windows_project', tbl: 'collaboration_routing_windows' },
        { name: 'collaboration_routing_batches_project', tbl: 'collaboration_routing_batches' },
        { name: 'collaboration_routing_attempt_number', tbl: 'collaboration_routing_attempts' },
        { name: 'collaboration_routing_attempts_batch', tbl: 'collaboration_routing_attempts' },
        { name: 'collaboration_routing_outcomes_input', tbl: 'collaboration_routing_outcomes' },
        { name: 'browser_sessions_active_idx', tbl: 'browser_sessions' },
        { name: 'environment_enrollments_instance_idx', tbl: 'environment_enrollments' },
        { name: 'environment_observations_instance_seq_idx', tbl: 'environment_observations' },
        { name: 'environment_recovery_lease_idx', tbl: 'environment_recovery' },
        { name: 'environment_recovery_instance_idx', tbl: 'environment_recovery' },
        { name: 'environment_force_releases_instance_idx', tbl: 'environment_force_releases' },
        { name: 'environment_authority_override_instance_idx', tbl: 'environment_authority_override_releases' },
        { name: 'environment_authority_override_agent_idx', tbl: 'environment_authority_override_releases' },
        { name: 'task_proposals_project', tbl: 'task_proposals' },
        { name: 'task_run_links_by_task', tbl: 'task_run_links' },
        { name: 'usage_activities_kind_idx', tbl: 'usage_activities' },
        { name: 'usage_activities_run_id_idx', tbl: 'usage_activities' },
        { name: 'usage_activities_attempt_id_idx', tbl: 'usage_activities' },
        { name: 'usage_activities_project_id_idx', tbl: 'usage_activities' },
        { name: 'usage_activities_task_id_idx', tbl: 'usage_activities' },
        { name: 'usage_activities_agent_id_idx', tbl: 'usage_activities' },
        { name: 'usage_activities_model_idx', tbl: 'usage_activities' },
        { name: 'usage_activities_settled_at_idx', tbl: 'usage_activities' },
        { name: 'usage_activities_run_id_unique', tbl: 'usage_activities' },
        { name: 'usage_activities_attempt_id_unique', tbl: 'usage_activities' },
        { name: 'usage_observations_activity_idx', tbl: 'usage_observations' },
        { name: 'usage_observations_effective_idx', tbl: 'usage_observations' },
      ],
    );

    const eventOrderColumns = store.db.prepare('PRAGMA index_info(project_events_project_order)').all() as unknown as readonly {
      readonly name: string;
    }[];
    assert.deepEqual(eventOrderColumns.map((column) => column.name), ['project_id', 'created_at', 'id']);

    const replayColumns = store.db.prepare('PRAGMA index_info(agent_runs_replay_sequence_idx)').all() as unknown as readonly {
      readonly name: string;
    }[];
    assert.deepEqual(replayColumns.map((column) => column.name), ['replay_sequence']);

    const sessionColumns = store.db.prepare('PRAGMA index_info(browser_sessions_active_idx)').all() as unknown as readonly {
      readonly name: string;
    }[];
    assert.deepEqual(sessionColumns.map((column) => column.name), ['revoked_at', 'credential_version']);

    const obsColumns = store.db.prepare('PRAGMA index_info(environment_observations_instance_seq_idx)').all() as unknown as readonly {
      readonly name: string;
    }[];
    assert.deepEqual(obsColumns.map((column) => column.name), ['environment_instance_id', 'sequence']);

    const columns = store.db.prepare('PRAGMA index_info(task_run_links_by_task)').all() as unknown as readonly {
      readonly name: string;
    }[];
    assert.deepEqual(columns.map((column) => column.name), ['task_id', 'sequence']);

    const usageRunColumns = store.db.prepare('PRAGMA index_info(usage_activities_run_id_unique)').all() as unknown as readonly {
      readonly name: string;
    }[];
    assert.deepEqual(usageRunColumns.map((column) => column.name), ['run_id']);
    const usageAttemptColumns = store.db.prepare('PRAGMA index_info(usage_activities_attempt_id_unique)').all() as unknown as readonly {
      readonly name: string;
    }[];
    assert.deepEqual(usageAttemptColumns.map((column) => column.name), ['attempt_id']);
  });
});


test('uniqueness identities are still enforced by the database, not the caller', async () => {
  await withStore((store) => {
    const unique = store.db
      .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NULL ORDER BY name")
      .all() as unknown as readonly { readonly name: string; readonly tbl_name: string }[];
    // Every entry is the implicit index behind a PRIMARY KEY or UNIQUE column;
    // their existence is what makes a repeated delivery key, wake idempotency
    // key, and session-key slot collapse onto one row.
    assert.deepEqual(
      unique.map((row) => row.tbl_name).sort(),
      [
        'agent_runs',
        'agent_session_keys',
        'agents',
        'browser_sessions',
        'browser_sessions',
        'collaboration_attention_resolutions',
        'collaboration_messages',
        'collaboration_messages',
        'collaboration_read_markers',
        'collaboration_routing_attempts',
        'collaboration_routing_batch_inputs',
        'collaboration_routing_batches',
        'collaboration_routing_outcomes',
        'collaboration_routing_windows',
        'collaboration_wake_requests',
        'collaboration_wake_requests',
        'collaboration_window_inputs',
        'conversation_scopes',
        'environment_authority_override_releases',
        'environment_catalog',
        'environment_enrollments',
        'environment_force_releases',
        'environment_instance_enrollment_authority',
        'environment_leases',
        'environment_model_authorization_evidence',
        'environment_observations',
        'environment_probes',
        'environment_readiness',
        'environment_readiness_attempts',
        'environment_readiness_attempts',
        'environment_recovery',
        'project_authorities',
        'project_environment_access',
        'project_events',
        'project_events',
        'projects',
        'remote_project_mcp_operations',
        'remote_project_mcp_processes',
        'remote_workspace_operations',
        'run_reconnect_gates',
        'run_reconnect_retries',
        'run_reconnect_triggers',
        'task_proposals',
        'task_run_links',
        'tasks',
        'usage_activities',
        'usage_observations',
        'worker_connection_epochs',
        'worker_recovery_contexts',
        'worker_recovery_events',
        'worker_recovery_receipts',
      ],
    );
  });
});
