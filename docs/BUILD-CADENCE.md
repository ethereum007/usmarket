# Continuous-build operating cadence

This chat has an active 30-minute continuation automation, created at the user's request on 20 October 2026. Scheduling is owned by the Codex app, not by GitHub Actions. Keep the local app/machine available for local execution. GitHub is the durable source of truth for code, tests, issues and acceptance evidence.

On each continuation:

1. Read AGENTS.md, RELEASE-PLAN.md, INDIA-US-PARITY.md and the open release milestone.
2. Check Git status and remote history. Preserve user changes; never reset or force-push to hide a conflict. If another active run owns an unfinished increment, do not overlap it.
3. Select one highest-priority unblocked issue. Prefer adapting an existing component/engine to writing a duplicate.
4. Finish a concrete increment with meaningful tests. A plan or status update alone is not a shipped increment.
5. Inspect staged files for credentials/runtime data. Commit and push to main when checks pass. Inspect CI before claiming the increment is verified.
6. Record exact commit/check evidence and remaining acceptance gaps in the issue. Keep partially satisfied issues open.
7. Notify the user only for meaningful shipped work, release failures or required decisions. Do not send repetitive timer/status messages or claim work happened because a wake-up occurred.

Do not silently purchase data, change subscriptions, place orders, communicate with third parties or deploy incomplete services publicly. Development can proceed on provider-independent tasks while commercial display rights, hosting or separate authentication configuration remain open decisions.
