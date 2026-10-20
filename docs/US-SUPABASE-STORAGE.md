# US Supabase plan storage (not activated)

Target supplied by user: etwmtakotrqlwwzttekc, under US Markets. Source migration: supabase/migrations/202610200001_us_plan_revisions.sql. No SQL has been applied by this increment.

The optional US_PLAN_STORE=supabase adapter uses the existing SUPABASE_URL/public key and each verified user's bearer token, never a service role key. Leave the flag unset until migration and real acceptance pass. Unknown modes fail closed; remote failures do not fall back to SQLite. SQLite remains the default for existing local tests/previews.

The migration revokes direct table access from anon/authenticated, enables RLS and exposes only a fixed-search-path, owner-filtered RPC to authenticated identities. Its security-definer function always uses auth.uid(); it accepts no owner selector. A transaction advisory lock serializes first and later saves by plan UUID. Source identity is immutable across revisions; stale edits and foreign UUID collisions return conflicts. Reads and downloads filter by verified database identity. No delete or update API is granted. Client-created own-account payloads are not verified research; the application API remains responsible for source-package/setup validation and invitations.

Before activation: apply the reviewed SQL only to the dedicated project; verify grants and two real test identities, concurrent expected_revision conflicts, source immutability, anonymous rejection and restart retention. Python transport mocks do not verify PostgreSQL semantics. Review the function and policies in Supabase before enabling the flag. Do not paste secrets into Git or chat.

This adapter stores plans only. Research packages, refresh jobs and coordination still use local files/SQLite and remain ephemeral on Render Free. Exported plan history does not contain its research packages. No complete durable-MVP or backup/restore acceptance is claimed. Remote package/job storage is the next increment; never enable a new-user journey that promises complete restart recovery until it passes.


## Research package adapter (not activated)

Migration 202610200002 adds owner-scoped immutable research packages and a fixed-search-path RPC. US_RESEARCH_STORE=supabase selects it; default local remains unchanged. Catalog/read requests use the verified account token; background publication receives its token only in memory, never in the persisted job payload. Completion is recorded only after the remote publish acknowledges the package ID. Failed remote reads never fall back to local evidence. Source packages are validated by the existing US metadata boundary before use in a plan. Same-identity replay retains the original observation; conflicting content is rejected. No shared cross-account research grants are introduced.

The SQL uses PostgREST PT409 errors for explicit conflicts. Python tests cover transport and routing only, not actual SQL execution. No migration has been applied. Jobs and refresh coordination remain local; token expiry during a long refresh can prevent remote publication and must remain a visible failure, not a completed claim. Research catalog reads return up to 120 newest recorded packages. A complete multi-host refresh/restore design remains open.
