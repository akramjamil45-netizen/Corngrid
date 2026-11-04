# Database Schema — Sandbox, Partner & Commission Tables

Applied automatically on SQLite (`sandbox/sandbox-schema.js`) or via `migrations/postgres/0005_sandbox.sql` for PostgreSQL. All timestamps are epoch milliseconds (BIGINT/INTEGER). Money is REAL/DOUBLE PRECISION in the row's `currency`.

## sandbox_nodes
Remote Windows hosting servers.

| Column | Type | Notes |
|---|---|---|
| id | PK | |
| node_uid | TEXT UNIQUE | public identifier (`node_…`) |
| name | TEXT | admin label |
| auth_token_hash | TEXT UNIQUE | SHA-256 of the node token (plaintext shown once) |
| status | TEXT | `pending` / `active` / `disabled` |
| is_test_node | BOOL | test nodes never host user sandboxes |
| max_instances | INT | capacity for load balancing |
| agent_version, machine_name, os_version | TEXT | reported by the agent |
| cpu_count, ram_mb, disk_free_mb | INT | capacity metrics |
| cpu_percent, memory_used_mb | REAL | live utilization |
| running_instances | INT | last reported count |
| last_heartbeat_at, last_seen_ip, connected_at, disconnected_at | TS | |
| created_at, updated_at | TS | |

## trading_strategies
Strategies selectable for sandbox deployment. The official `corngrid-ea` is seeded at startup; partner EAs appear after publishing.

| code (UNIQUE) | name | description | version | ea_file_name | ea_file_path | is_active | is_published | submission_id | created_at | updated_at |
|---|---|---|---|---|---|---|---|---|---|---|

## sandbox_instances
One active sandbox per user (partial unique index on `user_id WHERE deleted_at IS NULL`).

| Column | Notes |
|---|---|
| instance_uid | UNIQUE (`sbx_…`) |
| user_id | FK users |
| node_id | FK sandbox_nodes (NULL until allocated) |
| strategy_id | FK trading_strategies |
| status | `requested, allocating, deploying, starting, running, stopping, stopped, failed, suspended` |
| broker_server, mt5_account_number | connection target |
| account_masked | masked account for display |
| sandbox_path, process_id | reported by the agent |
| trading_paused | BOOL |
| last_heartbeat_at, last_error, started_at, stopped_at | |
| cpu_percent, memory_mb | live per-instance metrics |
| created_at, updated_at, deleted_at | soft delete |

## sandbox_credentials
| instance_id (UNIQUE FK) | cipher (AES-256-GCM `v1.iv.tag.data`) | key_version | created_at | updated_at |
|---|---|---|---|---|

## sandbox_logs
| id | instance_id (FK) | node_id (FK) | level (`debug/info/warn/error`) | source (`backend`/`agent`) | message | created_at |

## sandbox_deployments (command queue)
| id | command_uid (UNIQUE) | instance_id | node_id | command | status (`queued/sent/acknowledged/completed/failed/expired`) | payload_json | result_json | error | created_at | updated_at |

## sandbox_metrics
| id | node_id | instance_id (NULL = node-level) | cpu_percent | memory_mb | disk_free_mb | recorded_at |

## sandbox_events
| id | event_type | actor_type | actor_id | instance_id | node_id | payload_json | created_at |

## partner_profiles
| user_id (PK, FK users) | display_name | company | website | status (`active/suspended`) | payout_method | payout_details_cipher | created_at | updated_at |

## ea_submissions
| id | submission_uid (UNIQUE) | partner_id (FK users) | name | description | version | symbols | strategy_description | risk_description | documentation | status (`pending_review/under_review/testing/testing_failed/testing_passed/approved/rejected/published`) | review_notes | rejection_reason | reviewed_by | reviewed_at | published_at | strategy_id (FK) | created_at | updated_at | deleted_at |

## ea_versions
| id | submission_id (FK) | version | file_path | file_count | source_hash (SHA-256) | status (`stored/scan_failed/compiled/compile_failed`) | created_at |

## ea_test_reports
| id | submission_id (FK) | version_id (FK) | node_id (FK) | kind (`compile/runtime`) | status (`running/passed/failed`) | compile_log | runtime_log | cpu_avg | memory_peak_mb | error_count | started_at | finished_at | created_at |

## partner_commissions
| id | partner_id (FK) | strategy_id (FK, NULL = partner-wide default) | model (`percent/fixed`) | percent | fixed_amount | currency | applies_to (`subscription/renewal/both`) | min_payout_threshold | effective_from | effective_to | is_active | created_at | updated_at |

## partner_transactions (immutable ledger)
| id | reference (UNIQUE) | idempotency_key (UNIQUE, `payment:<id>:partner:<id>`) | partner_id (FK) | strategy_id | subscription_payment_id | subscription_id | gross_amount | commission_amount | currency | status (`pending/approved/paid/rejected/cancelled`) | notes | created_at | status_updated_at |

Amounts are never updated after insert; only `status`/`status_updated_at` change.

## partner_payouts
| id | payout_uid (UNIQUE) | partner_id (FK) | amount | currency | status (`pending/approved/paid/rejected`) | method | reference | admin_notes | requested_at | approved_by | approved_at | paid_at | created_at | updated_at |

## partner_payout_transactions
| payout_id (FK) | transaction_id (FK, UNIQUE) | — links a payout to the commissions it settles; PK (payout_id, transaction_id) |

## Relationships

```
users 1───∞ sandbox_instances ∞───1 sandbox_nodes
sandbox_instances 1───1 sandbox_credentials
sandbox_instances 1───∞ sandbox_logs / sandbox_deployments / sandbox_metrics
users 1───1 partner_profiles 1───∞ ea_submissions 1───∞ ea_versions / ea_test_reports
ea_submissions 1───0..1 trading_strategies (on publish)
partner_profiles 1───∞ partner_commissions / partner_transactions / partner_payouts
partner_payouts ∞───∞ partner_transactions  (via partner_payout_transactions)
subscription_payments ──► partner_transactions (commission on approval)
```
