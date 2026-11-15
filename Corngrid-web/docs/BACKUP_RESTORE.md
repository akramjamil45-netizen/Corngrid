# Private backups and restore verification

The existing SQLite scheduler remains unchanged. The operator CLI adds encrypted database + private-file snapshots and explicit restore verification. Nothing runs automatically or writes into a live database on installation. No backup/key/download endpoint is exposed on the website.

## Setup and scope

Provide `BACKUP_ENCRYPTION_KEY` through a private operator environment or secret manager: 64 hex characters representing 32 random bytes. Keep this key in a separate secure location; a backup without its decryption key cannot be recovered. Do not place the key in a command argument, Git, logs, public files or the archive destination. Backups use streaming gzip + AES-256-GCM with a random IV and authenticated version header. `.cgb` and temporary restore folders are ignored by Git.

The `--source` is the **Website root**, containing `Corngrid-web`. Its backend `.env` supplies source database configuration only. Explicit process environment values take precedence. Snapshot contents:

- PostgreSQL: a consistent `pg_dump --format=custom` archive; or SQLite: read-only `VACUUM INTO` snapshot.
- `Corngrid-web/.env`, when present: persistent sandbox/MFA/mail encryption keys and backend configuration stored in that file.
- `Corngrid-web/storage`, `Corngrid-web/public/uploads`, root `files`: approved/source EA artifacts, partner agreement receipts, uploads and updated resources.
- Node release signing/public keys from `SANDBOX_NODE_UPDATE_DIR`, when configured.

Secrets supplied only through a Windows service, external environment, vault or TLS certificate path **are not copied automatically**. Inventory and preserve those separately, including `MFA_ENCRYPTION_KEY`, `SANDBOX_ENCRYPTION_KEY`, mail encryption material and node signing keys. Agent/VPS MT5 folders, running terminal state, OS/service configuration, PostgreSQL roles/tablespaces and all node-local private configs require their separate infrastructure backup. Validate the inventory before calling a backup complete.

Output must be outside the Website tree, in a private directory with sufficient free space. Symlinks, unsafe paths, duplicate entries and an existing destination are refused. Files are hashed before and while streaming; a file that changes aborts the snapshot. Database and media are not a shared filesystem transaction: for a consistent application recovery point, use an operator maintenance window that pauses uploads, EA publications, agreement writes and configuration changes. Do not stop active trading terminals merely to back up the website. Failed backups are not valid recovery points.

## Create

```powershell
# Key already supplied privately in this operator session.
node Corngrid-web/scripts/platform-backup.js create --source C:\Website\Website --output D:\CornGridBackups\platform-20261116.cgb
```

```bash
node Corngrid-web/scripts/platform-backup.js create --source /srv/corngrid/Website --output /private-backups/platform-20261116.cgb
```

PostgreSQL client tools must be installed separately, with `pg_dump` matching or newer than the source server major version. Optional `PG_DUMP_BIN` / `PG_RESTORE_BIN` select trusted executables. Source credentials are passed only in child environment variables, not command arguments. Unexpected tool warnings/errors fail the operation rather than publishing an unverified archive. Encryption is streaming, but database dumps and restore verification still need private temporary disk space. The CLI prints aggregate metadata only.

These are logical application snapshots. They do not replace PostgreSQL physical/WAL backups and point-in-time recovery for a production recovery-time/data-loss objective. Set your retention, external copies, schedule, monitoring and PITR at the database/infrastructure layer. A scheduled Task Scheduler/cron invocation can call this CLI after the operator has configured its private environment; no scheduler is silently installed by the application.

## Verify in isolation

```powershell
node Corngrid-web/scripts/platform-backup.js verify --input D:\CornGridBackups\platform-20261116.cgb --report D:\CornGridBackups\last-verified.json
```

SQLite verification decrypts into a newly created private temporary directory, authenticates the entire ciphertext, validates member paths/sizes/hashes, opens only the extracted database, and runs `integrity_check`, `foreign_key_check` and a users count. The original database/files are never overwritten.

For PostgreSQL, supply `RESTORE_CONTROL_DATABASE_URL` for a **separate disposable test cluster**. Its role needs CREATE DATABASE and permission to restore the application schema. The verifier creates a random `corngrid_restore_check_<hex>` database, restores with `pg_restore --single-transaction --exit-on-error --no-owner --no-privileges`, verifies it can query users, and drops only that generated database afterward. Never use the production cluster for this workload. A trusted PostgreSQL dump can execute SQL during restore; use your own backup/key and an isolated test environment. Missing tools/permissions or failed cleanup fail verification. The control URL and dump credentials are never printed.

Restore verification checks decryption, file integrity and database readability; it does not start the website, test SMTP/Stripe/broker credentials or prove every licence can trade. Perform a complete staging acceptance test separately. A report includes `verified`, timestamps, engine, file/user counts and whether backend config/signing keys were included; it contains no key or customer details.

## Actual disaster recovery

An operator should provision a replacement host/database, verify a snapshot in isolation, restore global PostgreSQL roles/permissions as appropriate, recover configuration/keys from their private inventory, and use the database vendor's restore tooling. The library `ops/backup.js` exports `unpack` for a trusted operator tool: it returns a private extraction directory and a `dispose` cleanup function. This release deliberately provides no command that overwrites the live database or website. Test the recovered application without contacting live Stripe, SMTP, users or MT5 nodes, then approve a separate controlled cutover. Preserve node identity/licensing rules and prevent duplicate terminal deployment.

References: [PostgreSQL pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html), [PostgreSQL backup approaches](https://www.postgresql.org/docs/current/backup.html), [pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html).
