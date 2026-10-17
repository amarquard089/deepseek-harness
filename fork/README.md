# Fork governance: telemetry-free upstream sync

This directory holds the tooling that keeps this fork (`origin`) telemetry-free while tracking
`upstream` (`deepseek-ai/deepseek-harness`). It is fork-local: upstream does not contain it, so
merges never conflict here, and a conflict in `fork/` is itself a signal worth investigating.

## The hard requirement

Stated once, here, and enforced by executable gates rather than by review discipline:

> Every new upstream change must be validated, and may only become active or be merged into `master`
> when ALL telemetry, call-home behaviour, analytics and error reporting is stripped. No outbound
> request may leave this machine except model calls and the web search, web fetch and MCP servers the
> owner configured. No telemetry collection, no error logging — nothing may leave this fork.

Two consequences that shape every design decision below:

1. **Silence is not evidence.** A gate that cannot prove it ran is treated as a failure. The egress
   gate fails closed (exit `2`) when its own self-check does not observe a deliberate connection.
2. **The fork owns the decision, not the agent.** A red or unproven gate leaves the change on a side
   branch. Only a fully green gate run permits a merge into `master`.

## What is stripped

`fork/policy/core.json` is the machine-readable record of the removed surface: 8 package trees
(`packages/telemetry`, `packages/client/product-analytics`, `packages/client/ui-settings-session-log`,
`packages/host/product-telemetry-otel`, `packages/llm/plugin-package-inventory-deepseek`,
`packages/session/session-log-deepseek`, `packages/session/session-telemetry`,
`packages/session/session-telemetry-otel`), their documentation, and every reference to them from
dependency manifests, tsconfig path mappings, cordis compositions, generated catalogs and snapshots.

The strip is not a stored patch. It is re-derived from the policy by `fork/strip.mjs`, because a
483-file, 15k-line patch would conflict on every upstream merge. The gates then verify the result
independently.

### One deliberate exception

`packages/core/session/src/known-event-types.ts` still names the historical persisted session event
type `session-log-deepseek/delivery-accepted`. That is not live telemetry — it is required so that
already-released session data stays readable, which the repository treats as non-negotiable. It is
recorded as a justified residual in `fork/policy/rules-static.json` with that reason, and the static
gate also fails when a residual no longer matches anything, so the allowance cannot rot silently.

## Layout

| Path | Purpose |
| --- | --- |
| `fork/policy/core.json` | Stripped surface, gate list, merge policy, owner decisions. |
| `fork/policy/rules-static.json` | Content rules, forbidden dependencies, justified residuals. |
| `fork/policy/rules-egress.json` | Probe matrix and egress allowlist. |
| `fork/lib/policy.mjs` | Shared loader, report schema, exit codes, argv reader. |
| `fork/strip.mjs` | Idempotent re-application of the telemetry removal. |
| `fork/sync-upstream.mjs` | The orchestrator; the only component allowed to touch `master`. |
| `fork/verify-static.mjs` | Static gate. |
| `fork/verify-egress.mjs`, `fork/egress-shim.mjs` | Runtime egress gate and its interception shim. |
| `fork/reports/` | Per-run JSON and Markdown evidence (gitignored). |
| `fork/state/history.jsonl` | One durable line per sync run (gitignored). |

## Daily procedure

An in-session reminder (`schedule-0e45163f-99a8-40d0-817c-f32055c5aa79`, daily 08:00 Europe/Berlin)
starts the run. To run it by hand:

```sh
node fork/sync-upstream.mjs            # fetch, sync branch, strip, gates, merge on green, push
node fork/sync-upstream.mjs --dry-run  # everything except the final merge and push
```

The orchestrator: confirms the tree is safe to touch, backs up the protected tip to
`backup/master-pre-upstream-sync-<date>`, fetches `upstream`, and stops immediately with a report
when there is nothing new. Otherwise it creates `sync/upstream-<date>`, merges upstream into it,
re-applies the strip, builds, runs every required gate, and merges into `master` with `--no-ff` and
pushes only when every gate is green.

Overrides: `--dry-run`, `--no-merge`, `--no-push`, `--skip-build`, `--date YYYY-MM-DD`.

Exit codes: `0` clean (nothing to sync, or merged on green), `1` sync prepared but a gate failed so
nothing was merged, `2` preflight or internal error. `master` is never touched on `1` or `2`, and
no code path uses `--force`.

## Gates

Both gates share one report schema (`dsh-fork-gate-report/v1`) and one exit-code contract: `0` pass,
`1` violations, `2` the gate could not prove anything.

```sh
node fork/verify-static.mjs   # deletions, dependencies, composition, artifacts, residuals
node fork/verify-egress.mjs   # runtime proof that nothing dials out
```

The static gate answers "is the removed surface still absent, and has upstream introduced new
telemetry that is not in the denylist yet". The egress gate answers the harder question — "does the
built product actually attempt any connection" — by loading `fork/egress-shim.mjs` into real profile
boots through `--import`, intercepting `node:net`/`node:tls`/`node:dns`/`node:http(s)`/`fetch`/
undici/child processes, and asserting that no non-allowlisted destination was attempted. Loopback,
Unix sockets and pipes are recorded as local rather than as egress, so they can never masquerade as
either proof or violation.

The allowlist is derived only from explicit owner configuration and defaults to empty. Because there
is no API key in this checkout, an unconfigured boot is expected to attempt exactly zero connections.

## Reviewing a failed sync

1. Read `fork/reports/<date>-sync.md`; it names the failing rule ids, the violating paths and the
   reproduction command.
2. Reproduce the gate alone against the side branch:
   `git switch sync/upstream-<date> && node fork/verify-static.mjs`.
3. Either the strip needs extending (add the path, package name or rule to `fork/policy/*.json` and
   extend `fork/strip.mjs`) or the gate is over-firing (tighten the rule or add a justified residual
   **with a reason**).
4. Re-run from a clean tree. Only a green run may merge.

Never resolve a failed sync by weakening a gate to make it pass. If a rule is genuinely wrong, the
fix is a tighter rule plus its rationale in the policy file.

## Rollback

Every run creates `backup/master-pre-upstream-sync-<date>` before mutating anything, so a bad merge
is recoverable with `git reset --hard backup/master-pre-upstream-sync-<date>` (and a
`--force-with-lease` push if the bad merge was already published). The orchestrator itself never
force-pushes and aborts if the remote protected branch moved underneath it.

## Maintaining the policy

Upstream adds telemetry regularly, so this is a maintained surface, not a one-time cleanup:

- New telemetry discovered by a gate run: add the path or package to `core.json`, teach
  `strip.mjs` the reference shape, then re-run both gates.
- Residual allowances carry a reason and are re-checked on every run; a stale entry is a violation.
- `fork/policy/core.json` has a `policyRevision`; bump it when the stripped surface changes so
  reports can be correlated with policy state.

## Honest limits

- The egress gate proves the profiles it can boot on this machine. It cannot prove behaviour behind
  an unconfigured feature switch, or inside a browser renderer it did not launch; the static and
  artifact scans cover the shipped bundles that the boot probes cannot reach.
- Both gates run keyless, so they prove the absence of *unconfigured* egress. They do not exercise
  configured model, search or MCP traffic; that traffic is permitted by definition, and the
  allowlist is what keeps it bounded.
- A daily in-session reminder runs only while this session is alive. A missed occurrence collapses
  into the latest one when the session next wakes, so the sync interval can stretch; nothing is
  merged without a fresh green run for the exact commit being merged.
