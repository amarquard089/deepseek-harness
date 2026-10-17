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

## Resolving merge conflicts

A fork that permanently deletes files conflicts with upstream by construction: every time upstream
touches a stripped package, git reports modify/delete. The orchestrator resolves what policy can
prove and refuses the rest rather than guessing. It never merges over conflict markers, and any
resolved file that still contains one is downgraded to unresolved.

| Rule | Applies to | Resolution |
| --- | --- | --- |
| A | A conflicted path in the stripped package, documentation or file lists | Deleted. The strip's intent is that the path never exists. |
| B | A content conflict whose fork-side diff is entirely strip-related | Take upstream's side, then re-run the strip. |
| C | Anything else | Abort. Report the path, preserve the base/ours/theirs stages under `fork/reports/<date>-conflicts/`, never merge. |

Rule C is not a failure of the tooling — it is the tooling declining to make a product decision.
Resolve those paths by hand:

```sh
git switch sync/upstream-<date>
git merge upstream/master                      # restore the conflict markers
git checkout --merge -- <path>                 # per path, inspect the three stages
# generated documents: take upstream's side, then regenerate rather than hand-edit
pnpm run verify-translation-pairing --write <doc>     # `en:`/`zh:` pairing hashes
pnpm run gen-persistence-catalog                      # persistence index counts
node fork/strip.mjs                                   # re-apply the strip on top
node fork/verify-static.mjs && node fork/verify-egress.mjs
```

Some fork-side changes are genuinely not derivable from policy and must be kept deliberately — for
example `apps/web/tests/scaffold.ts` removes telemetry test scaffolding without naming a stripped
package, and `packages/experimental/browser-use-playwright-mcp/package.json` is a fork feature.
After resolution the orchestrator re-asserts that every fork-only added path still exists; that
invariant is what stops a conflict resolution from quietly deleting a feature.

## Observed evidence

Recorded on 2026-10-17 against `master` (`763aa8264e`, upstream `1600d8a1e1`):

- `node fork/verify-static.mjs` → exit 0, 43108 checks, 0 blockers, 12 warnings.
- `node fork/verify-egress.mjs` → exit 0, 29 interception records, 0 egress, 8 probes pass. Every
  profile probe's only records are the shim heartbeat, one tsx IPC pipe connect (Unix socket) and,
  for the web host, one loopback lookup. The self-check deliberately dials TEST-NET addresses and a
  `.invalid` name from the parent, a worker thread and a spawned child, and all of them are recorded.
- Calibration: run against **pristine upstream**, the static gate reports 1167 findings and 1016
  blockers (all 8 stripped package trees present, 412 identifier hits, 12 forbidden dependencies, 29
  OTel SDK imports, collector hosts and channel headers). A gate that passes there would be vacuous.
- The static gate legitimately failed this repository before the tooling landed: three dead tsconfig
  `include` entries still named the deleted `session-log-upload` and `feedback-release` e2e tests.
  Removing exactly those three made it green, which is how we know the gate is not simply stuck red.
- The first real sync attempt against the nine pending upstream commits resolved 8 of 16 conflicts by
  rule A and stopped on 8 that need the judgment described above. Nothing was merged.

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

## Reviewed warnings

The static gate stays green with visible warnings rather than suppressing them. Two recur and are
understood:

- `static.transitive-telemetry-package`: `@earendil-works/pi-telemetry` sits in the lockfile closure
  of `@earendil-works/pi-ai`. Reviewed on 2026-10-17 and found inert: `pi-ai` imports it **type-only**
  (`import type { TelemetryContext }` in `dist/types.d.ts`; the other hit is source-map text), the
  package documents itself as contracts only — "no exporter, global current-span state, or dependency
  on a telemetry backend" — its `dist/*.js` contains no network primitives, and no file under
  `packages/` or `apps/` references it. It stays a warning because static analysis cannot prove
  runtime inertness; the egress gate is the owner of that proof.
- `static.composition-stripped-plugin` on `snapshots/**/cordis*.yml`: rows that only *disable* a
  removed plugin (no module name), so nothing can be composed. They are inert, and they are recorded
  expectations, so removing them risks breaking recorded-session replay for no telemetry benefit.

## Honest limits

- The egress gate proves the profiles it can boot on this machine. It cannot prove behaviour behind
  an unconfigured feature switch, or inside a browser renderer it did not launch; the static and
  artifact scans cover the shipped bundles that the boot probes cannot reach. The desktop profile is
  owned by the Electron application and is rejected by the launcher headless, so its main-process
  egress surface is explicitly **not** proved and is reported as such on every run.
- Both gates run keyless, so they prove the absence of *unconfigured* egress. They do not exercise
  configured model, search or MCP traffic; that traffic is permitted by definition, and the
  allowlist is what keeps it bounded.
- Egress evidence is attempt-level interception, not a packet capture: a non-Node child (curl, git,
  ssh) is recorded as a spawn record, and kernel-level proof would need an OS network sandbox.
- A daily in-session reminder runs only while this session is alive. A missed occurrence collapses
  into the latest one when the session next wakes, so the sync interval can stretch; nothing is
  merged without a fresh green run for the exact commit being merged.
- The gates prove the telemetry property. They say nothing about whether a conflict resolution kept
  the product working — that is what the build in step 6 and the fork-local preservation invariant
  are for, and neither replaces the repository's own test suite.
