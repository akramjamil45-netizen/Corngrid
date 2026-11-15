# CornGrid platform improvements

Scope authorized on 16 November 2026: implement the five highest priorities in stages.

1. Admin System Health: implemented and tested through SQLite and PostgreSQL, authentication/routing checks and desktop/mobile browser acceptance.
2. Two-factor authentication: implemented with TOTP/manual setup, eight recovery codes, session-version invalidation and payout/bank step-up. RFC vector, concurrent SQLite/PostgreSQL verification, CSRF, session revocation and desktop/mobile enrollment tests pass.
3. Backup and restore validation: encrypted logical backup and isolated verification implemented; real SQLite and PostgreSQL snapshot/restore tests pass. A temporary loopback PostgreSQL cluster was created, tested and cleaned up without using production. Operator key/schedule/PITR configuration remains explicit.
4. Resource-aware sandbox allocation: implemented with fresh CPU/RAM/disk/platform checks, reservations and locked re-check; 29 focused integration tests pass. Admin node table explains resource blocks. No schema change or automatic terminal migration.
5. Staging and automated release checks: Windows/PostgreSQL/Linux/browser CI jobs, test-only staging launcher, candidate artifacts and canary/promotion guide implemented. A separate temporary checkout booted the real backend and verified health/auth and blocked SMTP/agents. Hosted CI and an actual staging/demo node require operator configuration and a push; no production promotion occurred.

Each stage must have focused tests, documentation and a reviewable result before the next stage. No production deployment, credential rotation, real payment or terminal restart is included in this development run.

Validation on 16 November 2026: complete application suite 337 passed, 3 PostgreSQL tests skipped in that ordinary run and separately executed successfully against the disposable cluster. Desktop/mobile browser checks passed at 1440px/375px without horizontal overflow. A compatible dependency audit fix removed eight advisories (including body-parser DoS); npm reported zero known vulnerabilities afterward. No major dependency upgrades were forced.

Before production: apply PostgreSQL `0019_auth_factors.sql`, preserve existing encryption keys, install locked dependencies and deploy the matching backend/assets/IIS rules. Enroll factors deliberately and save recovery codes. Configure private backup keys/schedules and branch/CI protection. Review resource thresholds against real node telemetry and perform the existing real-MT5/Linux acceptance before any release promotion. See `SYSTEM_HEALTH.md`, `TWO_FACTOR_AUTH.md`, `BACKUP_RESTORE.md`, `NODE_RESOURCE_POLICY.md` and `STAGING_RELEASE.md` for individual procedures.
