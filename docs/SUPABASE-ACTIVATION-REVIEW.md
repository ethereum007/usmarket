# Dedicated Supabase activation review — replacement target pending approval

Current target: replacement US Markets project apidhmrlawbjvisnadht, supplied by the user on 29 October 2026. Free plan must be verified before application. Previous target: etwmtakotrqlwwzttekc. No paid resources. The original request covered three migrations; current source has six, including cross-host admission, atomic publication and fenced interruption. Review the full current bundle before any activation. The 27 October approval covered only the previous project; it does not authorize application to the replacement target. The SQL bundle is unchanged. New-target approval and application remain pending.

Bundle fingerprint (canonical UTF-8/LF text): `6dd6e1ee11ca8e1ce214279b07d24a15f49c2da7ae5cfe4f17c9bae4c0ce323f`

| Migration, in execution order | SHA-256 of UTF-8/LF text |
|---|---|
| 202610200001_us_plan_revisions.sql | `ea99bfe5bdd4b90781876455e2281232d616e0a2bfafa1ab09b8733e829aee09` |
| 202610200002_us_research_packages.sql | `48c03541d1b0773d62f371591cc83f1a0fb7a4e6e7d8afc85c1015a0259c4b0c` |
| 202610200003_us_refresh_jobs.sql | `5d32232499c9fc4099781acc3397c5ed6566b53cea9c5fcf8d3337c58c36e3f1` |
| 202610260001_us_refresh_admission.sql | `85d3997128408ccdbad18edd571559373bb76c67996666fb73d94deef22f3305` |
| 202610260002_us_refresh_publication.sql | `06dbee7783298cb4b636392d1f11c50fd384e8b0f7001571ff2d9ffd87cd3d47` |
| 202610260003_us_refresh_interruption.sql | `e43a5046606e4d140a07f335a4d26e57ac06ac2b90fb47b8e031a1787a1aa984` |

The bundle creates three private owner-filtered storage tables, five authenticated-only security-definer RPCs with fixed empty search paths, plan RLS policies and an active-refresh uniqueness index. It revokes direct PUBLIC/anon/authenticated table access. The functions use auth.uid(), never a client owner selector. RPC access still requires application invitation/source validation; direct own-account payloads are not verified research. No source migration is applied by this document or fingerprint tool.

CI applies these source files to disposable PostgreSQL, tests owner/revision/publication/concurrency boundaries, then performs a synthetic dump/restore and verifies records, owner reads, RLS and access restrictions. This is not real Supabase gateway/account/retention acceptance.

Before any approved application, compare the latest manifest and Git revision to this review. Any changed fingerprint requires renewed review of the changed SQL. Run from backend: `python -m app.services.us_migration_review`. It reads only the allowlisted source files, makes no network request and prints no environment values. Windows CRLF and Linux LF checkouts intentionally have the same canonical fingerprint. CI rejects missing/extra/empty migrations and a stale document fingerprint.

Approval, when provided, should identify this dedicated project and reviewed bundle. Applying SQL does not authorize enabling storage flags, creating identities, changing credentials, activating paid resources or publishing an incomplete service. Keep flags off until controlled real-account isolation, sign-in/research/save/reopen/restart and backup/restore acceptance. The private MVP target of 25 October was missed; no replacement deadline is assigned here.


## Approval and application status — 27 October 2026

The user explicitly approved applying the reviewed six-migration bundle to US Markets project etwmtakotrqlwwzttekc on the Free plan. The source manifest was rechecked and matches bundle 6dd6e1ee11ca8e1ce214279b07d24a15f49c2da7ae5cfe4f17c9bae4c0ce323f. No additional migration or changed SQL is included.

Application has not occurred: the connected Supabase dashboard redirected to sign-in. The dashboard tab was left open for the user to sign in. No credentials, project settings, grants, data or feature flags were changed. After sign-in, inspect actual target/schema state before applying the bundle; do not blindly replay partially applied migrations. Any browser action-time confirmation requirements still apply immediately before material access changes. Storage flags and hosted acceptance remain off/pending; this approval does not authorize paid resources or new accounts.


## Read-only inspection before/after application

Use supabase/inspect_us_storage.sql in the confirmed dedicated project to inspect presence and structural security of the three tables, five exact RPC signatures and active-owner index. It reads PostgreSQL catalogs/privileges only, never payload rows or credentials, and changes nothing. Missing objects return false rather than triggering an attempted migration replay; present objects with false security_contract require investigation. The query checks RLS/direct client privileges, security-definer/empty search path and RPC role access, plus basic index validity/uniqueness/predicate presence. It does not certify function bodies, exact index predicate, configured invitations or real hosted persistence. Compare the approved source bundle and inspect differences before applying to an existing schema. This query is outside the approved migration inventory and does not modify its fingerprint. CI exercises passing structure, transactional permission drift and missing-object reporting in disposable PostgreSQL only.


## Replacement project — 29 October 2026

The user supplied https://supabase.com/dashboard/project/apidhmrlawbjvisnadht after being unable to recover access to the previous target. Backend and frontend target restrictions and synthetic fixtures now use the replacement reference. The previous project must be rejected before forwarding credentials. No keys, runtime environments, hosted settings, migrations or flags are changed by this source update. Verify dashboard identity, Free plan and actual schema, then obtain action-time approval for this exact unchanged six-file bundle on the replacement project. Prior approval/status entries above describe the old project only. Hosted acceptance and the missed 25 October gate remain unresolved.
