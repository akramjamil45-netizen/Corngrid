# Sandbox node names and placement priority

In **Admin → Sandbox Management → Sandbox nodes**, choose **Edit node** to
change a server's display name and placement priority. **Edit capacity** remains
a separate control. Names must be 2–80 characters; priority is a whole number
from 1 to 1000. Lower numbers are preferred, with 1 the highest priority.

All existing and newly registered nodes default to priority 100. When priorities
are equal, allocation uses the most free slots, then lowest CPU usage, then node
ID as a stable tie-break. The admin list sorts by priority, then ID; it is not a
live queue of eligible nodes.

For example, set a primary host to 1, a secondary host to 2 and a fallback host
to 3. New placements try each in that order. A full, disabled, offline, test or
resource-limited node is skipped. Explicit admin assignment still requires a
healthy node with free capacity. Subscription and activation checks still apply.

Renaming preserves the node UID, token, agent configuration and running
sandboxes. Editing priority affects future placements; it does not migrate or
restart an existing sandbox. No agent update is needed.

## API and auditing

- `GET /api/admin/sandbox/nodes` returns `placementPriority` and ordered nodes.
- `POST /api/admin/sandbox/nodes` accepts optional `placementPriority` (default 100).
- `PATCH /api/admin/sandbox/nodes/:id/settings` accepts `name`,
  `placementPriority`, `expectedName` and `expectedPlacementPriority`. The last
  two values are the baseline read when opening the edit dialog.

The existing admin authentication protects every endpoint. Stale edits return
409; retrying the same saved values succeeds without duplicating audit entries.
Changes are logged as `sandbox_node_settings_updated`. The browser checks saved
state after a dropped connection before retrying the absolute values once.

## Installation

Apply PostgreSQL migration `0022_sandbox_node_preferences.sql` before running
the new backend. It is repeatable and sets all existing nodes to equal priority
without changing the previous placement policy. Existing SQLite databases apply
the same column/index extension at startup through `sandbox-schema.js`.

Rollback: restore the preceding backend version, then apply
`migrations/rollback/0022_sandbox_node_preferences.sql` (PostgreSQL or SQLite
3.35+). This discards only priority metadata; display-name edits remain.
