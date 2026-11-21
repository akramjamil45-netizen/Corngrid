CREATE TABLE IF NOT EXISTS sandbox_proxy_servers (
 id INTEGER PRIMARY KEY AUTOINCREMENT, server_uid TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 certificate_fingerprint TEXT, auth_token_hash TEXT NOT NULL UNIQUE, auth_token_enc TEXT NOT NULL,
 last_heartbeat_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sandbox_proxy_endpoints (
 id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER NOT NULL REFERENCES sandbox_proxy_servers(id) ON DELETE CASCADE,
 public_ip TEXT NOT NULL UNIQUE, source_address TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), verified_at INTEGER, last_error TEXT,
 created_at INTEGER NOT NULL, UNIQUE(server_id,source_address)
);
CREATE TABLE IF NOT EXISTS sandbox_node_proxies (
 node_id INTEGER PRIMARY KEY REFERENCES sandbox_nodes(id) ON DELETE CASCADE,
 server_id INTEGER NOT NULL REFERENCES sandbox_proxy_servers(id) ON DELETE RESTRICT, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sandbox_proxy_leases (
 instance_id INTEGER PRIMARY KEY REFERENCES sandbox_instances(id) ON DELETE CASCADE,
 endpoint_id INTEGER NOT NULL REFERENCES sandbox_proxy_endpoints(id) ON DELETE RESTRICT,
 assigned_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proxy_endpoints_server ON sandbox_proxy_endpoints(server_id,enabled);
CREATE INDEX IF NOT EXISTS idx_proxy_leases_endpoint ON sandbox_proxy_leases(endpoint_id);
