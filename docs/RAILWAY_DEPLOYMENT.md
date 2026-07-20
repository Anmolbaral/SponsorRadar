# Railway deployment plan

Sponsor Winback Radar is prepared to deploy to Railway as one Node.js service.
It has **not** been deployed yet; production deployment and smoke testing are
the final project gate. The same
Next.js process serves the frontend, the workflow API, and the bounded LLM
agent. One Railway volume persists run snapshots, approvals, per-run credit
reservations, audit events, and evidence cache entries.

This is deliberately a single-instance deployment. Railway does not support
replicas on services with attached volumes, and the current filesystem
repository is designed for one service with cross-process filesystem locks.

## Repository-owned deployment contract

`railway.json` is authoritative for:

- Railpack as the builder;
- `pnpm build` as the build command;
- `pnpm start` as the start command;
- exactly one service replica;
- `/api/health` as the deployment healthcheck;
- a 300-second startup healthcheck window;
- restart-on-failure with at most 10 retries; and
- a 60-second SIGTERM drain window for in-flight bounded provider calls.

Railpack reads Node `>=22.18` and pnpm `11.9.0` from `package.json`. The
production build uses Next.js standalone output. Railway injects `PORT`; the
standalone server reads it at runtime.

## One-time Railway setup

1. Create one Railway project and a `production` environment.
2. Add one service from this repository, with the repository root as its root
   directory. Do not split the frontend and API into separate services.
3. Attach one volume to that service at `/app/.data`.
4. Keep the service at exactly one replica.
5. Add the service variables below. Seal the API keys and Basic Auth password.
6. Review and deploy the staged changes.
7. Generate a Railway domain under **Service → Settings → Networking**.
8. Schedule at least daily volume backups under the service **Backups** tab.

The absolute data directory is intentional. Railway mounts volumes only at
runtime, not during the build or pre-deploy phases.

## Production variables

Set these values on the one application service:

| Variable | Production value | Handling |
| --- | --- | --- |
| `UPRIVER_API_KEY` | Upriver server key | Required; sealed secret |
| `UPRIVER_MODE` | `live` | Required for real Upriver evidence |
| `UPRIVER_LIVE_WORKFLOW` | `true` | Required live-workflow interlock |
| `SPONSOR_RADAR_DATA_DIR` | `/app/.data/sponsor-radar` | Must live under the attached volume |
| `SPONSOR_RADAR_RUN_CREDIT_LIMIT` | `160` | Hard maximum for each new run. The current conservative uncached quote is 157. Values above 160 fail startup, and historical runs do not consume a lifetime balance |
| `SPONSOR_RADAR_QUOTE_TTL_MS` | `3600000` | One-hour approval quote |
| `SPONSOR_RADAR_BASIC_AUTH_USER` | Reviewer username | Required in production |
| `SPONSOR_RADAR_BASIC_AUTH_PASSWORD` | Long random password | Required; sealed secret |
| `SPONSOR_RADAR_LLM_MODE` | `openai` | Enables the OpenAI presentation adapter |
| `SPONSOR_RADAR_LIVE_LLM` | `true` | Required paid-LLM interlock |
| `OPENAI_API_KEY` | OpenAI server key | Required; sealed secret |
| `SPONSOR_RADAR_OPENAI_MODEL` | `gpt-5.6-terra` | Model pin used by the validated contract |

Do not add `NEXT_PUBLIC_` aliases for any server key or password. Do not enable
`UPRIVER_LIVE_SMOKE`, `SPONSOR_RADAR_LIVE_LLM_SMOKE`, or
`SPONSOR_RADAR_LIVE_LLM_DEEP` in the hosted service; those flags belong only
to manually invoked validation commands.

`PORT`, `NODE_ENV`, `RAILWAY_VOLUME_NAME`, and
`RAILWAY_VOLUME_MOUNT_PATH` are platform-provided and should not be copied from
a local `.env` file. If the runtime cannot write to the volume because a future
image changes to a non-root user, set `RAILWAY_RUN_UID=0`; Railpack's current
configuration does not opt into a non-root UID, so do not set this override
unless deployment logs show a volume permission error.

## Deployment and smoke gate

Run the local gate before uploading:

```bash
pnpm verify
```

With an authenticated and linked Railway CLI, deploy from the repository root:

```bash
railway up
```

The Railway CLI is installed but remains unauthenticated and unlinked. No
Railway project, service, volume, domain, or deployment should be inferred from
this document.

After Railway reports the deployment healthy, verify through the generated
HTTPS domain:

```bash
curl --fail --silent --show-error \
  --user "$SPONSOR_RADAR_BASIC_AUTH_USER:$SPONSOR_RADAR_BASIC_AUTH_PASSWORD" \
  "https://YOUR_DOMAIN/api/health"
```

Then complete one browser run:

1. authenticate with the reviewer credentials;
2. create a run for an exact public YouTube handle or channel URL that is not
   the frozen `@UrAvgConsumer` fixture;
3. confirm the UI moves directly into compact progress without exposing
   research-plan, peer-review, or credit-review controls;
4. wait for the bounded Upriver and optional OpenAI execution to finish;
5. verify evidence links and confirm every live lead is labeled as same-brand
   reactivation with product, campaign, and buyer continuity unverified; and
6. refresh the page and confirm the completed run restores from the volume.

Check Railway logs for a single bounded execution, zero provider retries,
redacted audit output, and no raw credentials. Confirm that the run-specific
ledger on the volume records a 160-credit maximum and the settled stage usage.
The closed legacy shared ledger must remain unchanged except when finalizing a
pre-existing active legacy claim.

The maximum uncached quote should currently reconcile to 157 credits: one
initial target result, one forced-fresh execution revalidation, up to ten
Similar Beta results provisionally priced at
one creator-result credit each, up to 23 grouped target sponsor results, and up
to two grouped sponsor results for each of three peers. Treat the Similar Beta
rate and all result-based totals as provisional until the Upriver dashboard or
provider confirms billing. See
[the external API issue register](EXTERNAL_API_ISSUE_REGISTER.md).

## Operational constraints

- A volume-backed service has brief redeploy downtime because Railway cannot
  mount the same volume into overlapping deployments.
- Railway volumes cannot be used with multiple replicas. Move the persistence
  port to Postgres before horizontal scaling.
- Railway's deployment healthcheck is not continuous monitoring. Add an
  external uptime monitor if this moves beyond the take-home review.
- Volume backups are incremental but must be scheduled explicitly.
- Keep staging and production in separate Railway environments with separate
  volumes and credentials.
- Keep the service private behind Basic Auth for the take-home. The current
  filesystem persistence and per-run accounting are not multi-tenant authorization.

## Railway references

- [Next.js deployment guide](https://docs.railway.com/guides/nextjs)
- [Config as code reference](https://docs.railway.com/config-as-code/reference)
- [Healthchecks](https://docs.railway.com/deployments/healthchecks)
- [Using volumes](https://docs.railway.com/volumes)
- [Volume limitations and permissions](https://docs.railway.com/volumes/reference)
- [Variables and sealed secrets](https://docs.railway.com/variables)
- [Railpack Node and pnpm detection](https://railpack.com/languages/node/)
