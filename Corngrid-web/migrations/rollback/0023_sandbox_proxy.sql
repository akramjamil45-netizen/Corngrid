-- Disconnect proxy assignments and stop proxy daemons/bridges before rollback.
-- Restoring a database snapshot is required to recover discarded proxy metadata.
BEGIN;
DROP TABLE IF EXISTS sandbox_proxy_leases;
DROP TABLE IF EXISTS sandbox_node_proxies;
DROP TABLE IF EXISTS sandbox_proxy_endpoints;
DROP TABLE IF EXISTS sandbox_proxy_servers;
COMMIT;
