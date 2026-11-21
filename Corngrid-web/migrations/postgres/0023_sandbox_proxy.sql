BEGIN;
CREATE TABLE IF NOT EXISTS sandbox_proxy_servers (
 id SERIAL PRIMARY KEY, server_uid TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
 enabled BOOLEAN NOT NULL DEFAULT FALSE, certificate_fingerprint TEXT,
 auth_token_hash TEXT NOT NULL UNIQUE, auth_token_enc TEXT NOT NULL,
 last_heartbeat_at BIGINT, last_error TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS sandbox_proxy_endpoints (
 id SERIAL PRIMARY KEY, server_id INTEGER NOT NULL REFERENCES sandbox_proxy_servers(id) ON DELETE CASCADE,
 public_ip TEXT NOT NULL UNIQUE, source_address TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE,
 verified_at BIGINT, last_error TEXT, created_at BIGINT NOT NULL, UNIQUE(server_id,source_address)
);
CREATE TABLE IF NOT EXISTS sandbox_node_proxies (
 node_id INTEGER PRIMARY KEY REFERENCES sandbox_nodes(id) ON DELETE CASCADE,
 server_id INTEGER NOT NULL REFERENCES sandbox_proxy_servers(id) ON DELETE RESTRICT, updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS sandbox_proxy_leases (
 instance_id INTEGER PRIMARY KEY REFERENCES sandbox_instances(id) ON DELETE CASCADE,
 endpoint_id INTEGER NOT NULL REFERENCES sandbox_proxy_endpoints(id) ON DELETE RESTRICT, assigned_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proxy_endpoints_server ON sandbox_proxy_endpoints(server_id,enabled);
CREATE INDEX IF NOT EXISTS idx_proxy_leases_endpoint ON sandbox_proxy_leases(endpoint_id);
COMMIT;
