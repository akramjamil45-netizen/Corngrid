# Staging and release checks

## Automated candidate checks

`.github/workflows/platform-checks.yml` runs on pull requests, pushes and manual dispatch with read-only repository permissions. Windows runs the complete application suite and builds credential-free Windows/Linux node candidates. Ubuntu uses a disposable PostgreSQL 16 service to test actual migrations, cross-pool MFA races, backup restore, database timeout recovery and Linux runtime simulations. Shell syntax/dry-run checks do not install Wine or start MT5. Candidate artifacts are tied to the source commit and retained for 14 days; no production secrets, deploy command, signing-key publication or live payment is part of the workflow. GitHub Actions must be enabled and the changes pushed for hosted CI to execute.

Protect the production branch with both job checks and review approval. GitHub Actions/branch/environment settings are repository-owner configuration, not silently changed by this code. Dependabot checks action references weekly; review updates and pin reviewed action commits if your repository policy requires immutable action references. The current upstream major action references follow the official action documentation.

## Separate staging checkout

Use a separate checkout or host, with its own private storage and database. Do not run a staging copy from the live website directory. Never copy production node configs or customer records into a public test site. Use synthetic accounts and test-mode data.

1. Install locked dependencies with `npm ci` in `Corngrid-web`.
2. Copy `.env.staging.example` to private `.env.staging`, which Git ignores. Supply a new long JWT secret, persistent 32-byte hex encryption key, test administrator email and bcrypt password hash. Generate/store them privately; do not reuse production keys/passwords. Use a database path containing `staging`/`test`, or a PostgreSQL database name ending `_staging`/`_test`.
3. Validate without starting anything:

```powershell
node scripts/start-staging.js --config .env.staging --check
```

4. For PostgreSQL, create a new staging database and run `node scripts/start-staging.js --config .env.staging --migrate`. This validates the staging configuration and passes only its explicit test database to the normal migration tool. Never rely on a production shell's default `DATABASE_URL`. SQLite applies the existing additive schema at startup.
5. Start the staging backend:

```powershell
node scripts/start-staging.js --config .env.staging
```

The launcher reads the separate config, rejects reuse of the checkout's live database/keys/hash, rejects live Stripe keys and SMTP configuration, forces loopback `127.0.0.1:3100` by default, disables automatic agent publication and backups, and gives the child an explicit `CORNGRID_ENV_FILE`. Backend responses carry `X-CornGrid-Environment: staging`. Administrator email management/delivery workers are not registered in staging, including when a restored database contains old queue rows. Registration-email testing belongs in isolated automated fixtures; outbound SMTP is disabled here.

Both HTTP and WebSocket agent access are denied unless the request's node UID matches `STAGING_DEMO_NODE_UID`, and normal node-token authentication still applies. Leave it empty for ordinary UI/auth/payment tests. For demo MT5 acceptance, register a **new staging-only node identity**, configure that one demo node's backend to the staging origin and deliberately whitelist its UID. Do not reuse an active production node ID/token. If the node is remote, an operator must configure a protected HTTPS staging proxy/tunnel and corresponding trusted app origin; the default loopback launcher is intentionally not a public deployment tool.

Stripe remains disabled unless Sandbox/test keys are explicitly configured. Use only test Checkout transactions and the matching test webhook secret. New MFA seeds and stored secrets use staging keys. The launcher never changes the live IIS binding, Cloudflare tunnel, Windows services, production database or running terminals.

## Acceptance and deliberate promotion

Record the exact candidate commit and artifact hashes. Before promotion:

- All automated jobs pass; desktop/mobile health, authenticator enrollment/recovery, old-session rejection and sensitive-action prompts pass.
- Restore a fresh backup into an isolated test cluster; verify the private key/file inventory and a functioning staged application. Successful logical restore does not replace a full infrastructure recovery rehearsal.
- Stripe test payment activates once, webhook retries remain safe and DuitNow review still works with synthetic records.
- One demo node deploys an approved EA/preset, verifies broker identity and licence, reports real EA heartbeat and handles stop/restart without affecting a second demo terminal. Measure admission RAM/disk estimates. Linux/Wine needs its separate real-MT5 acceptance; simulated runtime tests do not prove it.
- For a node-agent release, canary one dedicated demo node, verify signed update/adoption/rollback and its actual MT5 PID/heartbeat. Existing global auto-update publication should stay paused until the candidate is accepted.
- Obtain an explicit production deployment approval. Back up first, apply migration **0019_auth_factors.sql**, deploy the complete matching asset/backend set, verify origin/proxy/readiness/admin login and only then enable further node update publication through the existing workflow. This development task does not perform that promotion.

Keep previous website files and a verified backup. Schema changes are additive; prefer rolling back compatible code rather than deleting factor records. Once MFA is enrolled, an older authentication release that does not enforce MFA is **not a safe rollback target**. Preserve the new security checks or disable enrollments before the maintenance plan, with appropriate authorization. Never discard keys, factor rows or licence state just to make old code start.

Local tests: `npm test`; `node test/helpers/run-isolated-postgres.cjs` creates its own temporary loopback PostgreSQL cluster when PostgreSQL 16 tools are installed on Windows. It never uses `.env`, existing PGDATA or a production service. `npm run test:browser` starts its own isolated in-memory UI fixture and tests desktop/mobile enrollment and health. Install the development Chromium binary once with `npx playwright install chromium`, or set `PLAYWRIGHT_BROWSER_CHANNEL=chrome` to use an existing Chrome installation with a fresh test context. The Ubuntu CI job installs Chromium and runs these UI checks automatically.

References: [GitHub Actions setup-node](https://github.com/actions/setup-node), [checkout](https://github.com/actions/checkout), [Playwright CI](https://playwright.dev/docs/ci).
