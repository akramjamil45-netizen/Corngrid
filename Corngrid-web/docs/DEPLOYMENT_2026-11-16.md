# Platform improvements deployment — 16 November 2026

The operator authorized production deployment and a Git commit after the five-stage implementation was completed. The development-only limits described in `PLATFORM_IMPROVEMENTS.md` applied to the earlier implementation run; this release has now been deployed.

## Applied

- Added PostgreSQL migration `0019_auth_factors.sql` in a transaction before deploying the authentication code. Existing accounts were not enrolled automatically.
- Deployed 39 runtime, asset, configuration and operator documentation files. Installed the nine runtime package versions from the tested lockfile; existing native SQLite/sharp modules were retained and loaded successfully.
- Restarted only `CornGridWeb`. The gateway, sandbox agents and all three pre-existing MT5 terminal processes were preserved. Both existing sandbox instances reported running afterward.
- Production `.env` and encryption/payment keys were unchanged. The sandbox agent release remained at its existing published version; no fleet update was published by this deployment.
- Saved the original files, replaced dependency directories, a deployment manifest and a PostgreSQL snapshot in an access-restricted directory under `C:\ProgramData\CornGrid\WebsiteBackups\platform-20261115-200314` (UTC directory timestamp). The snapshot is private deployment rollback material, not a configured encrypted recurring backup service.

## Verification

- Backend readiness passed, PostgreSQL responded and all ten admin health checks executed successfully. Unauthenticated access to health diagnostics was rejected.
- Public and gateway checks passed for the admin/workplace/login pages, versioned health/security assets and updated service worker. Script/style hashes matched the deployed source.
- Read-only compatibility checks passed for existing authenticated user profile, MT5 accounts, subscription overview, MFA status and sandbox status APIs. No production test account, factor enrollment or payment was created.
- The health page reported all three nodes online and one node with a resource warning. Existing running sandboxes remain operational; administrators should review that node before allocating additional workloads.
- Pre-deployment application suite: 337 passed, three PostgreSQL tests skipped in the ordinary run and separately passed on an isolated PostgreSQL cluster. Desktop/mobile browser acceptance passed at 1440/375 pixels. Dependency audit reported zero known vulnerabilities after compatible fixes.

## Operator follow-up

- Enroll admin/eligible partner two-factor authentication deliberately and store recovery codes privately.
- Configure `BACKUP_ENCRYPTION_KEY`, an external backup destination, retention and a schedule before relying on recurring encrypted backups. Validate restores on an isolated database.
- Push the commit and enable GitHub Actions/branch protection for hosted CI. Candidate artifact builds do not deploy or publish agent releases automatically. An actual staging/demo node and real Linux/Wine MT5 acceptance remain separate release gates.

The deployment helper is `marketing/deploy-platform-improvements.ps1`. It prepares and validates a pending change set against its Git baseline, protects rollback material, applies the additive migration and verifies the backend. Rollback refuses to restore old authentication code after a factor version has been activated, because that would weaken the new authentication boundary. It never restores a database snapshot automatically.
