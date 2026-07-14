# SIMM Telemetry Platform and Administrative Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone SIMM telemetry API and worker that accepts explicit, anonymous desktop uploads, produces reviewable compatibility intelligence, serves the public web client, and provides a role-protected administration console.

**Architecture:** Create `E:\WebstormProjects\simmtelemetryapi` as the independently deployed system of record. Its Fastify API validates and stores anonymous upload batches in a telemetry schema, a Postgres worker derives aggregate compatibility observations, and an account/admin schema holds only website identities and moderation data. SIMM sends retriable, previewed batches over HTTPS; `E:\WebstormProjects\simmwebclient` consumes only public aggregate endpoints and authenticated administration endpoints, never the telemetry tables.

**Tech Stack:** Bun, TypeScript, Fastify, Zod, PostgreSQL 16, Drizzle ORM, `postgres`, Argon2id, `@fastify/jwt`, React 19, Vite, Vitest, Rust/Tauri, `reqwest`.

## Global Constraints

- Desktop telemetry is disabled until the user explicitly enables collection and upload; upload always requires a rendered local payload preview.
- Telemetry must contain no account ID, machine/device/client ID, username, email, absolute path, IP address, Steam/Nexus token, full log, or cross-upload identifier.
- Website account, billing, support, creator-claim, and administrator records live in the `app` schema and have no foreign key, query, event, or analytics join to the `telemetry` schema.
- An upload UUID is single-use idempotency metadata for retrying one request; it expires with the raw batch and must not identify an installation or person.
- The server stores no readable telemetry excerpts. It accepts an optional client-sanitized excerpt only to validate and derive a fingerprint, then discards it before persistence.
- Raw normalized batch data expires after 30 days. Aggregates, moderation decisions, and audit records have their separately documented retention policies.
- Public compatibility statuses are not automatically published from a sample threshold. They remain `pending` until an administrator publishes a review decision or an approved policy later enables automatic publication.
- The API is the only caller of PostgreSQL. The public web client and SIMM desktop application use HTTPS endpoints only.
- Use UTC ISO-8601 timestamps and opaque UUIDs. Log request IDs and result codes, never request bodies or authorization values.
- Frontend work must pass `bun install`, `bunx tsc --noEmit`, `bun run lint`, `bun run test`, and `bun run build`; SIMM contract work also passes `cargo check --manifest-path src-tauri/Cargo.toml` and `cargo test --manifest-path src-tauri/Cargo.toml`.

---

## Proposed repository boundaries

| Repository | Responsibility | Must not contain |
| --- | --- | --- |
| `E:\WebstormProjects\simmtelemetryapi` | HTTP API, worker, PostgreSQL schema, OpenAPI contract, admin authorization, moderation | Desktop UI state or Vite pages |
| `E:\CLionProjects\simmrust` | Local capture, exact preview, durable anonymous upload queue, upload controls | Account credentials or direct database access |
| `E:\WebstormProjects\simmwebclient` | Public compatibility browser and `/admin` client UI | Telemetry fixtures as production data or database credentials |

## Server data model and request flow

```mermaid
flowchart LR
  S["SIMM local history"] --> P["Exact local preview"]
  P -->|"explicit upload"| I["POST /v1/telemetry/batches"]
  I --> T[("telemetry schema")]
  T --> W["aggregation worker"]
  W --> A[("app public records")]
  A --> PUB["public API"]
  A --> ADM["admin API"]
  PUB --> WEB["simmwebclient public pages"]
  ADM --> CONSOLE["simmwebclient /admin"]
```

`telemetry.upload_batches` retains the submitted upload UUID, schema version, received time, expiry time, processing state, and rejection reason. `telemetry.sessions`, `telemetry.session_mods`, and `telemetry.events` hold normalized, short-lived anonymous facts. `app.canonical_mods`, `app.mod_source_aliases`, `app.compatibility_tracks`, `app.public_warnings`, `app.review_decisions`, and `app.site_content` hold the reviewed, publishable model used by the web client. `app.users`, `app.user_roles`, `app.mod_claims`, and `app.audit_log` hold account and administration data only.

When an uploaded mod has no matching source alias, the worker creates or reuses an `app.mod_identity_candidates` row keyed by normalized source, name, and author, and records aggregate evidence against that candidate. Candidates are internal-only and cannot appear in public responses. An administrator may map a candidate to an existing canonical mod or promote it into a new draft canonical mod; the worker then moves its aggregate evidence to the canonical record.

The worker treats a completed session with no `ERROR` or `FATAL` attributed to a mod as one healthy observation for that mod/version/runtime/branch; a mod-attributed error produces one error-signature observation. System/unknown errors are retained as batch-review evidence but do not mark every installed mod unhealthy. Incomplete sessions contribute no health observation. This prevents a game-wide error from becoming a false per-mod failure rate.

### Task 1: Bootstrap the standalone API and enforce configuration boundaries

**Files:**

- Create: `E:\WebstormProjects\simmtelemetryapi\package.json`
- Create: `E:\WebstormProjects\simmtelemetryapi\src\config.ts`
- Create: `E:\WebstormProjects\simmtelemetryapi\src\app.ts`
- Create: `E:\WebstormProjects\simmtelemetryapi\src\server.ts`
- Create: `E:\WebstormProjects\simmtelemetryapi\src\config.test.ts`
- Create: `E:\WebstormProjects\simmtelemetryapi\.env.example`
- Create: `E:\WebstormProjects\simmtelemetryapi\README.md`

**Interfaces:**

- Produces: `loadConfig(env): AppConfig` and `buildApp(config): FastifyInstance`.
- Produces: `GET /healthz -> { status: 'ok' }` and request IDs for all responses.
- Consumes: `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGIN`, `PORT`, and `ADMIN_BOOTSTRAP_EMAIL` from process environment.

- [ ] **Step 1: Create the Bun project manifest and safe environment template.**

```json
{
  "name": "simmtelemetryapi",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/server.ts",
    "start": "bun src/server.ts",
    "worker": "bun src/worker.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  }
}
```

```dotenv
DATABASE_URL=postgres://simm:simm@127.0.0.1:5432/simm_telemetry
JWT_SECRET=replace-with-a-32-byte-random-secret
CORS_ORIGIN=http://localhost:5173
PORT=8787
ADMIN_BOOTSTRAP_EMAIL=admin@example.invalid
```

- [ ] **Step 2: Write the failing configuration tests.**

```ts
it('refuses startup when a production JWT secret is missing', () => {
  expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow('JWT_SECRET is required');
});

it('does not accept a wildcard CORS origin', () => {
  expect(() => loadConfig(validEnv({ CORS_ORIGIN: '*' }))).toThrow('CORS_ORIGIN must be an explicit origin');
});
```

- [ ] **Step 3: Implement typed configuration and the HTTP shell.**

```ts
export type AppConfig = Readonly<{
  databaseUrl: string;
  jwtSecret: string;
  corsOrigin: string;
  port: number;
  adminBootstrapEmail: string;
}>;

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET is required');
  if (!env.CORS_ORIGIN || env.CORS_ORIGIN === '*') throw new Error('CORS_ORIGIN must be an explicit origin');
  if (!env.ADMIN_BOOTSTRAP_EMAIL) throw new Error('ADMIN_BOOTSTRAP_EMAIL is required');
  return { databaseUrl: env.DATABASE_URL, jwtSecret: env.JWT_SECRET, corsOrigin: env.CORS_ORIGIN, port: Number(env.PORT ?? 8787), adminBootstrapEmail: env.ADMIN_BOOTSTRAP_EMAIL };
}
```

- [ ] **Step 4: Run the bootstrap checks.**

Run: `bun install; bun run typecheck; bun run lint; bun run test`

Expected: all commands exit `0`; `/healthz` returns HTTP `200` with `{ "status": "ok" }`.

- [ ] **Step 5: Commit the independently runnable API shell.**

```powershell
git -C E:\WebstormProjects\simmtelemetryapi add package.json src .env.example README.md
git -C E:\WebstormProjects\simmtelemetryapi commit -m "chore: bootstrap telemetry API service"
```

### Task 2: Define the versioned anonymous-upload contract before storage code

**Files:**

- Create: `E:\WebstormProjects\simmtelemetryapi\src\contracts\telemetry.ts`
- Create: `E:\WebstormProjects\simmtelemetryapi\src\contracts\telemetry.test.ts`
- Create: `E:\WebstormProjects\simmtelemetryapi\openapi\telemetry-v1.yaml`
- Create: `E:\WebstormProjects\simmtelemetryapi\test\fixtures\live-telemetry-v1.json`
- Create: `E:\CLionProjects\simmrust\test-fixtures\live-telemetry-v1.json`
- Modify: `E:\CLionProjects\simmrust\docs\mod-telemetry-server-resources.md`

**Interfaces:**

- Consumes: SIMM `LiveTelemetryExport` fields in `src-tauri/src/types.rs`.
- Produces: `TelemetryBatchSchema`, `TelemetryBatch`, `validateTelemetryBatch(value)`, and the API contract `POST /v1/telemetry/batches`.
- Produces: `GET /v1/telemetry/schema -> { acceptedSchemaVersions: [1], maxSessions: 100, maxEventsPerSession: 5000, maxBodyBytes: 1048576 }`.

- [ ] **Step 1: Write the contract fixture and rejection tests first.**

```ts
it('accepts the checked-in schema v1 fixture', () => {
  expect(validateTelemetryBatch(fixture)).toMatchObject({ schemaVersion: 1 });
});

it.each(['C:\\Users\\A\\Latest.log', 'person@example.com', '/home/a/.config'])(
  'rejects forbidden telemetry text: %s',
  (message) => expect(() => validateTelemetryBatch(batchWithMessage(message))).toThrow('forbidden telemetry text'),
);
```

- [ ] **Step 2: Implement the exact envelope and conservative field limits.**

```ts
export const TelemetryBatchSchema = z.object({
  schemaVersion: z.literal(1),
  uploadId: z.string().uuid(),
  exportedAt: z.string().datetime(),
  sessions: z.array(SessionSchema).min(1).max(100),
}).strict();

const EventSchema = z.object({
  eventId: z.string().regex(/^event-[0-9a-f]{32}$/),
  occurredAt: z.string().datetime(),
  severity: z.enum(['WARN', 'ERROR', 'FATAL']),
  attribution: z.enum(['mod', 'system', 'unknown']),
  modKey: z.string().max(128).nullable(),
  modName: z.string().max(160).nullable(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  message: z.string().max(600).nullable(),
  source: z.string().max(160),
  lineNumber: z.number().int().positive().nullable(),
  origin: z.enum(['attach', 'live']),
}).strict();
```

- [ ] **Step 3: Specify the idempotent response in OpenAPI and document the renamed endpoint.**

```yaml
post:
  operationId: ingestTelemetryBatch
  responses:
    '202':
      description: Accepted for asynchronous aggregation
    '200':
      description: Previously accepted uploadId; safe retry
    '400':
      description: Invalid, unsafe, or unsupported payload
    '413':
      description: Body is larger than 1 MiB
```

- [ ] **Step 4: Add SIMM-side fixture conformance coverage without enabling upload.**

```rust
#[test]
fn live_telemetry_v1_fixture_uses_the_documented_contract() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!("../../../test-fixtures/live-telemetry-v1.json")).unwrap();
    assert_eq!(fixture["schemaVersion"], 1);
    assert!(fixture["uploadId"].as_str().unwrap().parse::<uuid::Uuid>().is_ok());
}
```

- [ ] **Step 5: Run contract validation in both repositories.**

Run: `bun run test -- src/contracts/telemetry.test.ts; cargo test --manifest-path E:\CLionProjects\simmrust\src-tauri\Cargo.toml live_telemetry_v1_fixture`

Expected: valid fixture passes; paths, emails, unknown fields, unsupported schema versions, and over-limit collections fail deterministically.

- [ ] **Step 6: Commit the contract before accepting live traffic.**

```powershell
git -C E:\WebstormProjects\simmtelemetryapi add src/contracts openapi test/fixtures
git -C E:\WebstormProjects\simmtelemetryapi commit -m "feat: define anonymous telemetry v1 contract"
git -C E:\CLionProjects\simmrust add docs/mod-telemetry-server-resources.md test-fixtures/live-telemetry-v1.json src-tauri/src/services/telemetry.rs
git -C E:\CLionProjects\simmrust commit -m "test: verify telemetry upload contract fixture"
```

### Task 3: Build migrations and anonymous telemetry intake

**Files:**

- Create: `E:\WebstormProjects\simmtelemetryapi\src\db\schema.ts`
- Create: `E:\WebstormProjects\simmtelemetryapi\drizzle\0000_initial.sql`
- Create: `E:\WebstormProjects\simmtelemetryapi\src\telemetry\repository.ts`
- Create: `E:\WebstormProjects\simmtelemetryapi\src\telemetry\routes.ts`
- Create: `E:\WebstormProjects\simmtelemetryapi\src\telemetry\routes.test.ts`
- Modify: `E:\WebstormProjects\simmtelemetryapi\src\app.ts`

**Interfaces:**

- Consumes: `TelemetryBatch` from Task 2.
- Produces: `insertAcceptedBatch(batch): Promise<'accepted' | 'duplicate'>`.
- Produces: `POST /v1/telemetry/batches -> 202 { uploadId, state: 'queued' } | 200 { uploadId, state: 'duplicate' }`.

- [ ] **Step 1: Write the route tests against a disposable PostgreSQL database.**

```ts
it('stores a validated batch and returns a queued receipt', async () => {
  const response = await app.inject({ method: 'POST', url: '/v1/telemetry/batches', payload: fixture });
  expect(response.statusCode).toBe(202);
  expect(response.json()).toEqual({ uploadId: fixture.uploadId, state: 'queued' });
});

it('returns duplicate without creating a second batch', async () => {
  await submit(fixture);
  expect((await submit(fixture)).statusCode).toBe(200);
  expect(await countRows('telemetry.upload_batches')).toBe(1);
});
```

- [ ] **Step 2: Create separated schemas and expiry-aware tables.**

```sql
CREATE SCHEMA IF NOT EXISTS telemetry;
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE telemetry.upload_batches (
  upload_id uuid PRIMARY KEY,
  schema_version integer NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
  processing_state text NOT NULL CHECK (processing_state IN ('queued','processing','processed','rejected')),
  rejection_code text
);

CREATE TABLE telemetry.events (
  id uuid PRIMARY KEY,
  upload_id uuid NOT NULL REFERENCES telemetry.upload_batches(upload_id) ON DELETE CASCADE,
  event_fingerprint char(64) NOT NULL,
  severity text NOT NULL,
  attribution text NOT NULL,
  mod_identity text,
  occurred_at timestamptz NOT NULL
);

CREATE TABLE app.canonical_mods (
  id uuid PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  author text NOT NULL DEFAULT '',
  publication_state text NOT NULL CHECK (publication_state IN ('draft','published')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.mod_source_aliases (
  id uuid PRIMARY KEY,
  canonical_mod_id uuid NOT NULL REFERENCES app.canonical_mods(id),
  source_kind text NOT NULL,
  normalized_name text NOT NULL,
  normalized_author text NOT NULL DEFAULT '',
  UNIQUE (source_kind, normalized_name, normalized_author)
);

CREATE TABLE app.source_metadata (
  alias_id uuid PRIMARY KEY REFERENCES app.mod_source_aliases(id),
  display_label text NOT NULL,
  source_url text,
  download_count bigint,
  star_count bigint,
  refreshed_at timestamptz
);

CREATE TABLE app.mod_identity_candidates (
  id uuid PRIMARY KEY,
  source_kind text NOT NULL,
  normalized_name text NOT NULL,
  normalized_author text NOT NULL DEFAULT '',
  canonical_mod_id uuid REFERENCES app.canonical_mods(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, normalized_name, normalized_author)
);
```

- [ ] **Step 3: Insert only normalized fields and deliberately drop `message`.**

```ts
await tx.insert(uploadBatches).values({ uploadId: batch.uploadId, schemaVersion: batch.schemaVersion, processingState: 'queued' });
for (const event of session.events) {
  await tx.insert(events).values({
    id: eventUuid(event.eventId), uploadId: batch.uploadId, eventFingerprint: event.fingerprint,
    severity: event.severity, attribution: event.attribution,
    modIdentity: event.modName ? normalizeModIdentity(event.modName) : null,
    occurredAt: new Date(event.occurredAt),
  });
}
```

- [ ] **Step 4: Cap the body at 1 MiB, register the schema route, and add CORS only for the configured web origin.**

Run: `bun run db:migrate; bun run test -- src/telemetry/routes.test.ts`

Expected: successful intake never persists a message column or raw JSON body; retry receives `200 duplicate`.

- [ ] **Step 5: Commit ingestion as a deployable, non-publicating slice.**

```powershell
git -C E:\WebstormProjects\simmtelemetryapi add drizzle src/db src/telemetry src/app.ts
git -C E:\WebstormProjects\simmtelemetryapi commit -m "feat: ingest anonymous telemetry batches"
```

### Task 4: Derive aggregates and expire raw telemetry in a separate worker

**Files:**

- Create: `E:\WebstormProjects\simmtelemetryapi\src\worker.ts`
- Create: `E:\WebstormProjects\simmtelemetryapi\src\telemetry\aggregate.ts`
- Create: `E:\WebstormProjects\simmtelemetryapi\src\telemetry\retention.ts`
- Create: `E:\WebstormProjects\simmtelemetryapi\src\telemetry\aggregate.test.ts`
- Modify: `E:\WebstormProjects\simmtelemetryapi\drizzle\0000_initial.sql`

**Interfaces:**

- Consumes: queued, completed sessions and their normalized events.
- Produces: `app.compatibility_tracks`, `app.error_signature_counts`, `processQueuedBatches(limit)`, and `deleteExpiredRawTelemetry(now)`.
- Produces: aggregate rows keyed by a canonical mod ID or internal identity-candidate ID, mod version, S1 version, branch, runtime, and fingerprint; never by upload ID or account ID.

- [ ] **Step 1: Write aggregation behavior tests.**

```ts
it('records a healthy observation only for a completed error-free mod session', async () => {
  await processBatch(completedSession({ events: [] }));
  expect(await trackCounts()).toEqual({ healthy: 1, errored: 0, unknown: 0 });
});

it('does not mark every installed mod broken for a system error', async () => {
  await processBatch(completedSession({ events: [systemFatal()] }));
  expect(await trackCounts()).toEqual({ healthy: 0, errored: 0, unknown: 1 });
});
```

- [ ] **Step 2: Add aggregate tables and a queue-safe claim query.**

```sql
CREATE TABLE app.compatibility_tracks (
  canonical_mod_id uuid REFERENCES app.canonical_mods(id),
  identity_candidate_id uuid REFERENCES app.mod_identity_candidates(id),
  mod_version text NOT NULL,
  s1_version text NOT NULL,
  branch text NOT NULL,
  runtime text NOT NULL,
  healthy_count bigint NOT NULL DEFAULT 0,
  errored_count bigint NOT NULL DEFAULT 0,
  unknown_count bigint NOT NULL DEFAULT 0,
  last_observed_at timestamptz NOT NULL,
  PRIMARY KEY (canonical_mod_id, identity_candidate_id, mod_version, s1_version, branch, runtime),
  CHECK ((canonical_mod_id IS NULL) <> (identity_candidate_id IS NULL))
);

CREATE TABLE app.error_signature_counts (
  canonical_mod_id uuid NOT NULL REFERENCES app.canonical_mods(id),
  event_fingerprint char(64) NOT NULL,
  severity text NOT NULL,
  observed_count bigint NOT NULL DEFAULT 0,
  last_observed_at timestamptz NOT NULL,
  PRIMARY KEY (canonical_mod_id, event_fingerprint, severity)
);

SELECT upload_id FROM telemetry.upload_batches
WHERE processing_state = 'queued'
ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT $1;
```

- [ ] **Step 3: Implement idempotent aggregation and the daily retention sweep.**

```ts
export async function deleteExpiredRawTelemetry(now = new Date()) {
  return db.transaction(async (tx) => {
    await tx.delete(uploadBatches).where(lt(uploadBatches.expiresAt, now));
  });
}
```

- [ ] **Step 4: Run the worker checks.**

Run: `bun run test -- src/telemetry/aggregate.test.ts; bun run worker --once`

Expected: rerunning a processed batch does not change counts; expired batches cascade-delete sessions and events while aggregate counts remain.

- [ ] **Step 5: Commit the asynchronous processing boundary.**

```powershell
git -C E:\WebstormProjects\simmtelemetryapi add drizzle src/worker.ts src/telemetry
git -C E:\WebstormProjects\simmtelemetryapi commit -m "feat: aggregate telemetry compatibility evidence"
```

### Task 5: Serve public compatibility records from reviewed server data

**Files:**

- Create: `E:\WebstormProjects\simmtelemetryapi\src\public\repository.ts`
- Create: `E:\WebstormProjects\simmtelemetryapi\src\public\routes.ts`
- Create: `E:\WebstormProjects\simmtelemetryapi\src\public\routes.test.ts`
- Modify: `E:\WebstormProjects\simmtelemetryapi\openapi\telemetry-v1.yaml`
- Modify: `E:\WebstormProjects\simmwebclient\src\types.ts`
- Create: `E:\WebstormProjects\simmwebclient\src\lib\http.ts`
- Modify: `E:\WebstormProjects\simmwebclient\src\lib\publicApi.ts`
- Modify: `E:\WebstormProjects\simmwebclient\src\lib\publicApi.test.ts`
- Modify: `E:\WebstormProjects\simmwebclient\src\pages\DownloadPage.tsx`
- Modify: `E:\WebstormProjects\simmwebclient\src\pages\PricingPage.tsx`
- Modify: `E:\WebstormProjects\simmwebclient\src\pages\PrivacyPage.tsx`

**Interfaces:**

- Produces: `GET /v1/mods`, `GET /v1/mods/:slug`, `GET /v1/mods/:slug/health`, and `GET /v1/site-content/:key`, with cursor pagination and explicit filter query parameters.
- Produces: the web client `PublicApi` interface with `searchMods(filters): Promise<CanonicalModRecord[]>`, `getModHealth(slug): Promise<CanonicalModRecord | null>`, and `getFeaturedMods(): Promise<CanonicalModRecord[]>`.
- Consumes: only published canonical records, reviewed warnings, public source aliases, and aggregates.

- [ ] **Step 1: Write API tests that prove private evidence cannot leak.**

```ts
it('returns a published mod record without telemetry identifiers or error excerpts', async () => {
  const response = await app.inject('/v1/mods/backpackplus');
  expect(response.json()).toMatchObject({ slug: 'backpackplus', sampleSize: 4 });
  expect(response.body).not.toMatch(/uploadId|fingerprint|message|sessionId/i);
});

it('returns 404 for an unpublished canonical mod', async () => {
  expect((await app.inject('/v1/mods/internal-draft')).statusCode).toBe(404);
});
```

- [ ] **Step 2: Return a stable, fixture-compatible public DTO.**

```ts
export type PublicModRecord = {
  slug: string; name: string; version: string; author: string; summary: string;
  status: 'known-good' | 'risky' | 'known-breaking' | 'pending';
  confidence: 'High' | 'Medium' | 'Limited' | 'Pending';
  sampleSize: number | null; sampleBreakdown: { good: number; bad: number; unknown?: number } | null;
  sources: SourceIdentity[]; warnings: PublicWarning[]; trackRecord: PublicTrack[];
  currentRead: string; detailSummary: string; suggestedAction: string; indexedAt: string;
};
```

- [ ] **Step 3: Convert the web client adapter to async HTTP while retaining fixtures only for unit fixtures.**

```ts
export async function searchMods(filters: Partial<ModSearchFilters> = {}) {
  return http.get<CanonicalModRecord[]>('/v1/mods', { ...defaultFilters, ...filters });
}

export async function getModHealth(slug: string) {
  return http.getOrNull<CanonicalModRecord>(`/v1/mods/${encodeURIComponent(slug)}`);
}

export async function getPublishedSiteContent(key: 'announcement' | 'download' | 'pricing' | 'privacy') {
  return http.get<{ key: string; content: unknown; publishedAt: string }>(`/v1/site-content/${key}`);
}
```

- [ ] **Step 4: Update `HomePage`, `CompatibilityPage`, and `ModHealthPage` to render loading, empty, and request-failure states; update `DownloadPage`, `PricingPage`, and `PrivacyPage` to render only published server-controlled content.**

Run: `bun run test -- src/public/routes.test.ts; bunx tsc --noEmit; bun run lint; bun run test; bun run build`

Expected: a public page renders server data; a failure does not silently render fake compatibility results.

- [ ] **Step 5: Commit backend and frontend public-data wiring separately.**

```powershell
git -C E:\WebstormProjects\simmtelemetryapi add src/public openapi
git -C E:\WebstormProjects\simmtelemetryapi commit -m "feat: expose published compatibility records"
git -C E:\WebstormProjects\simmwebclient add src
git -C E:\WebstormProjects\simmwebclient commit -m "feat: load public compatibility data from API"
```

### Task 6: Add separate website accounts, RBAC, and auditable administrative APIs

**Files:**

- Create: `E:\WebstormProjects\simmtelemetryapi\src\auth\passwords.ts`
- Create: `E:\WebstormProjects\simmtelemetryapi\src\auth\routes.ts`
- Create: `E:\WebstormProjects\simmtelemetryapi\src\auth\requireRole.ts`
- Create: `E:\WebstormProjects\simmtelemetryapi\src\admin\routes.ts`
- Create: `E:\WebstormProjects\simmtelemetryapi\src\admin\service.ts`
- Create: `E:\WebstormProjects\simmtelemetryapi\src\admin\routes.test.ts`
- Create: `E:\WebstormProjects\simmtelemetryapi\src\cli\bootstrapAdmin.ts`
- Modify: `E:\WebstormProjects\simmtelemetryapi\drizzle\0000_initial.sql`

**Interfaces:**

- Produces: account roles `admin`, `reviewer`, and `creator`; signed access token plus secure refresh cookie.
- Produces: `requireRole('admin' | 'reviewer')` and immutable `appendAuditLog(actorId, action, targetType, targetId, summary)`.
- Produces: `/v1/admin/dashboard`, `/v1/admin/mods`, `/v1/admin/reviews`, `/v1/admin/warnings`, `/v1/admin/claims`, `/v1/admin/intake/batches`, and `/v1/admin/site-content`.

- [ ] **Step 1: Write authorization and separation tests.**

```ts
it('rejects anonymous access to administration', async () => {
  expect((await app.inject('/v1/admin/dashboard')).statusCode).toBe(401);
});

it('allows reviewers to draft but only admins to publish', async () => {
  expect((await asReviewer().post('/v1/admin/warnings').send(draft)).statusCode).toBe(201);
  expect((await asReviewer().post('/v1/admin/warnings/w1/publish')).statusCode).toBe(403);
});

it('does not select telemetry tables in an account query', async () => {
  expect(await accountRepository.findByEmail('admin@example.invalid')).not.toHaveProperty('uploadId');
});
```

- [ ] **Step 2: Create accounts, roles, claims, review, and audit tables in the `app` schema.**

```sql
CREATE TABLE app.users (id uuid PRIMARY KEY, email citext UNIQUE NOT NULL, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE app.user_roles (user_id uuid NOT NULL REFERENCES app.users(id), role text NOT NULL CHECK (role IN ('admin','reviewer','creator')), PRIMARY KEY (user_id, role));
CREATE TABLE app.audit_log (id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES app.users(id), action text NOT NULL, target_type text NOT NULL, target_id text NOT NULL, summary jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE app.site_content (key text PRIMARY KEY, draft jsonb NOT NULL, published jsonb NOT NULL, updated_by uuid NOT NULL REFERENCES app.users(id), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE app.public_warnings (id uuid PRIMARY KEY, canonical_mod_id uuid NOT NULL REFERENCES app.canonical_mods(id), severity text NOT NULL CHECK (severity IN ('Severe','Warning','Info')), public_reason text NOT NULL, developer_confirmed boolean NOT NULL DEFAULT false, publication_state text NOT NULL CHECK (publication_state IN ('draft','published')), created_by uuid NOT NULL REFERENCES app.users(id), published_at timestamptz);
CREATE TABLE app.review_decisions (id uuid PRIMARY KEY, canonical_mod_id uuid NOT NULL REFERENCES app.canonical_mods(id), decision text NOT NULL CHECK (decision IN ('pending','known-good','risky','known-breaking')), rationale text NOT NULL, created_by uuid NOT NULL REFERENCES app.users(id), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE app.mod_claims (id uuid PRIMARY KEY, canonical_mod_id uuid NOT NULL REFERENCES app.canonical_mods(id), claimant_user_id uuid NOT NULL REFERENCES app.users(id), evidence_url text NOT NULL, state text NOT NULL CHECK (state IN ('pending','approved','rejected','needs-evidence')), reviewed_by uuid REFERENCES app.users(id), reviewed_at timestamptz, reviewer_note text);
```

- [ ] **Step 3: Implement Argon2id passwords, secure token delivery, and first-admin bootstrap.**

```ts
export async function hashPassword(password: string) {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export function requireRole(...roles: Role[]) {
  return async (request: AuthenticatedRequest) => {
    if (!request.user || !roles.includes(request.user.role)) throw app.httpErrors.forbidden();
  };
}
```

- [ ] **Step 4: Implement the operational admin resources.**

The dashboard returns counts for queued/failed intake, unreviewed canonical identities, draft/published warnings, claim queue, worker health, and site-content drafts. Intake list/detail pages show only batch timestamps, schema result, session/environment version facts, mod identity candidates, severity counts, and fingerprints—never raw text or user identifiers. Canonical mod actions create/merge aliases, connect source metadata, define tracks, set a publication state, and append a before/after audit summary. Claim actions accept, reject, or request evidence and grant the `creator` role only after administrator approval. Site-content actions publish only allow-listed structured keys: `announcement`, `download`, `pricing`, and `privacy`; each update preserves the last published value and creates an audit record.

- [ ] **Step 5: Run the auth and admin test suite.**

Run: `bun run test -- src/auth src/admin; bun run typecheck; bun run lint`

Expected: `admin` may publish and manage roles; `reviewer` may prepare evidence; `creator` sees only claimed mod diagnostics; telemetry never appears in account identity queries.

- [ ] **Step 6: Commit protected operations.**

```powershell
git -C E:\WebstormProjects\simmtelemetryapi add drizzle src/auth src/admin src/cli
git -C E:\WebstormProjects\simmtelemetryapi commit -m "feat: add audited telemetry administration"
```

### Task 7: Build the web administration console against the protected API

**Files:**

- Create: `E:\WebstormProjects\simmwebclient\src\lib\adminApi.ts`
- Create: `E:\WebstormProjects\simmwebclient\src\pages\AdminSignInPage.tsx`
- Create: `E:\WebstormProjects\simmwebclient\src\pages\AdminDashboardPage.tsx`
- Create: `E:\WebstormProjects\simmwebclient\src\pages\AdminIntakePage.tsx`
- Create: `E:\WebstormProjects\simmwebclient\src\pages\AdminModEditorPage.tsx`
- Create: `E:\WebstormProjects\simmwebclient\src\pages\AdminClaimsPage.tsx`
- Create: `E:\WebstormProjects\simmwebclient\src\pages\AdminSiteContentPage.tsx`
- Create: `E:\WebstormProjects\simmwebclient\src\pages\adminPages.test.tsx`
- Modify: `E:\WebstormProjects\simmwebclient\src\App.tsx`
- Modify: `E:\WebstormProjects\simmwebclient\src\types.ts`
- Modify: `E:\WebstormProjects\simmwebclient\src\styles.css`

**Interfaces:**

- Consumes: `/v1/auth/login`, `/v1/auth/refresh`, and the Task 6 admin endpoints.
- Produces: `/admin`, `/admin/intake`, `/admin/mods/:id`, `/admin/claims`, and `/admin/site-content`, with role-sensitive route guards.
- Produces: `AdminApi.getDashboard()`, `listIntake()`, `saveCanonicalMod(input)`, `publishWarning(id)`, and `reviewClaim(id, decision)`.

- [ ] **Step 1: Write user-facing authorization tests.**

```tsx
it('redirects an anonymous visitor from /admin to /admin/sign-in', async () => {
  renderAt('/admin');
  expect(await screen.findByRole('heading', { name: /administrator sign in/i })).toBeInTheDocument();
});

it('hides publish controls from a reviewer', async () => {
  mockAdminSession({ role: 'reviewer' });
  renderAt('/admin/mods/mod-1');
  expect(screen.queryByRole('button', { name: /publish warning/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Implement one authenticated HTTP client with refresh and 401 handling.**

```ts
export async function adminRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, { ...init, credentials: 'include', headers: { 'content-type': 'application/json', ...init.headers } });
  if (response.status === 401) window.location.assign('/admin/sign-in');
  if (!response.ok) throw new Error(`Admin request failed: ${response.status}`);
  return response.json() as Promise<T>;
}
```

- [ ] **Step 3: Implement the admin workflows in this order.**

1. Dashboard with worker state, pending batches, pending source identities, draft warnings, and claim queue counts.
2. Intake review with only safe aggregate fields; promote a mod-name candidate into a new or existing canonical record.
3. Canonical mod editor with source alias merge, track status, public copy, draft/published warning state, and an audit-history panel.
4. Creator-claim queue with evidence link, claim decision, role grant/revoke, and rejection note.
5. Site-content editor for the structured announcement, download, pricing, and privacy fields, with draft/preview/publish and audit history. It does not expose an unrestricted HTML editor.

- [ ] **Step 4: Run web-client validation.**

Run: `bun install; bunx tsc --noEmit; bun run lint; bun run test; bun run build`

Expected: public routes remain accessible without a session; admin routes never rely on telemetry fixture data; role boundaries render correctly.

- [ ] **Step 5: Commit the administration console.**

```powershell
git -C E:\WebstormProjects\simmwebclient add src
git -C E:\WebstormProjects\simmwebclient commit -m "feat: add telemetry administration console"
```

### Task 8: Add SIMM’s explicit, durable upload pipeline and exact preview

**Files:**

- Create: `E:\CLionProjects\simmrust\src-tauri\migrations\0006_telemetry_upload_queue.sql`
- Modify: `E:\CLionProjects\simmrust\src-tauri\src\types.rs`
- Modify: `E:\CLionProjects\simmrust\src\types\index.ts`
- Modify: `E:\CLionProjects\simmrust\src-tauri\src\services\telemetry.rs`
- Create: `E:\CLionProjects\simmrust\src-tauri\src\services\telemetry_upload.rs`
- Create: `E:\CLionProjects\simmrust\src-tauri\src\commands\telemetry_upload.rs`
- Modify: `E:\CLionProjects\simmrust\src-tauri\src\main.rs`
- Modify: `E:\CLionProjects\simmrust\src\services\api.ts`
- Modify: `E:\CLionProjects\simmrust\src\components\TelemetryWorkspace.tsx`
- Create: `E:\CLionProjects\simmrust\src-tauri\src\config\telemetry_upload.rs`
- Create: `E:\CLionProjects\simmrust\src-tauri\src\services\telemetry_upload.test.rs`

**Interfaces:**

- Produces: `TelemetryUploadPreview`, `TelemetryUploadReceipt`, and queue states `pending`, `sending`, `accepted`, `failed`.
- Produces Tauri commands `preview_telemetry_upload`, `queue_telemetry_upload`, `list_telemetry_uploads`, and `retry_telemetry_upload`.
- Consumes: the Task 2 telemetry contract and `POST /v1/telemetry/batches` through `reqwest`.
- Consumes: a compile-time `TELEMETRY_UPLOAD_BASE_URL` with `https` required outside the development build.

- [ ] **Step 1: Write failing Rust tests for consent, retry identity, and HTTP results.**

```rust
#[tokio::test]
async fn queueing_requires_collection_and_upload_opt_in() {
    let result = service.queue_upload(None).await;
    assert!(result.unwrap_err().to_string().contains("upload opt-in"));
}

#[tokio::test]
async fn retry_reuses_one_upload_id_and_never_rebuilds_the_payload() {
    let queued = service.queue_upload(None).await.unwrap();
    assert_eq!(queued.upload_id, service.retry_upload(&queued.id).await.unwrap().upload_id);
}
```

- [ ] **Step 2: Store a local queued payload with a random, per-upload UUID and no account field.**

```sql
CREATE TABLE IF NOT EXISTS telemetry_upload_queue (
  id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','sending','accepted','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

- [ ] **Step 3: Change export preparation to build a fresh upload envelope only when queued.**

```rust
pub struct TelemetryUploadEnvelope {
    pub schema_version: u32,
    pub upload_id: String,
    pub exported_at: String,
    pub sessions: Vec<LiveTelemetryExportSession>,
}
```

Filter upload candidates to ended sessions, retain no local environment ID, and preserve the same serialized `payload` for every retry. Do not add an automatic timer: the user presses **Upload reviewed telemetry**, and later presses **Retry** after a failed request.

- [ ] **Step 4: Render a real review screen, not only a count.**

The workspace’s **Preview export** action opens a dialog with the exact serialized payload, totals, explicit exclusions, and a disabled-by-default upload checkbox. The checkbox becomes available only after the user reads the preview; pressing **Upload reviewed telemetry** creates a queue item and sends it. The UI shows `Accepted`, `Already accepted`, `Failed before acceptance`, or `Rejected: <safe server code>` without echoing server request bodies.

- [ ] **Step 5: Verify the desktop upload boundary.**

Run: `bun install; bunx tsc --noEmit; bun run lint; bun run test; bun run build; cargo check --manifest-path src-tauri/Cargo.toml; cargo test --manifest-path src-tauri/Cargo.toml telemetry_upload`

Expected: disabled telemetry cannot queue; the preview contains no local IDs/paths; one retry sends byte-identical JSON with the same one-time upload UUID; a successful response marks the local item accepted.

- [ ] **Step 6: Commit SIMM upload support.**

```powershell
git -C E:\CLionProjects\simmrust add src-tauri src
git -C E:\CLionProjects\simmrust commit -m "feat: upload reviewed anonymous telemetry batches"
```

### Task 9: Operationalize deployment, monitoring, and release safety

**Files:**

- Create: `E:\WebstormProjects\simmtelemetryapi\Dockerfile`
- Create: `E:\WebstormProjects\simmtelemetryapi\docker-compose.yml`
- Create: `E:\WebstormProjects\simmtelemetryapi\src\ops\metrics.ts`
- Create: `E:\WebstormProjects\simmtelemetryapi\src\ops\metrics.test.ts`
- Create: `E:\WebstormProjects\simmtelemetryapi\docs\runbook.md`
- Create: `E:\WebstormProjects\simmtelemetryapi\docs\data-retention.md`
- Modify: `E:\WebstormProjects\simmwebclient\src\data\publicData.ts`
- Modify: `E:\WebstormProjects\simmwebclient\src\pages\PrivacyPage.tsx`

**Interfaces:**

- Produces: separate `api` and `worker` processes, PostgreSQL health checks, `/healthz`, `/readyz`, and a protected `/metrics` endpoint.
- Produces: metric names `telemetry_batches_accepted_total`, `telemetry_batches_rejected_total`, `telemetry_batch_processing_seconds`, `telemetry_raw_expired_total`, and `admin_actions_total`.
- Produces: an operational runbook for backup/restore, migration, worker backlog, rejected-schema investigation, source outage, account compromise, and retention verification.

- [ ] **Step 1: Write observability tests that forbid privacy leaks.**

```ts
it('records only a rejection code and schema version for a rejected upload', () => {
  recordTelemetryRejected({ code: 'forbidden_text', schemaVersion: 1 });
  expect(metricsText()).toContain('telemetry_batches_rejected_total');
  expect(metricsText()).not.toContain('person@example.com');
});
```

- [ ] **Step 2: Create a local production-shaped stack.**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: simm_telemetry
      POSTGRES_USER: simm
      POSTGRES_PASSWORD: local-dev-only
  api:
    build: .
    command: bun run start
  worker:
    build: .
    command: bun run worker
```

- [ ] **Step 3: Document the edge and deployment contract.**

The production reverse proxy terminates TLS, restricts `/metrics` to operations access, limits `POST /v1/telemetry/batches` by source IP without passing IP data to the application, caps bodies at 1 MiB, and forwards only standard request metadata. The API service must not write `x-forwarded-for` values into telemetry tables or analytics. Daily encrypted backups cover `app` data; raw telemetry is excluded from backups after its 30-day expiry sweep.

- [ ] **Step 4: Replace web-client privacy placeholders with implemented facts.**

State that telemetry uploads are anonymous, account-separate, raw-text-free server-side, retained for 30 days, and published only as reviewed aggregates. Keep the effective date accurate when this release goes live.

- [ ] **Step 5: Run the release rehearsal.**

Run: `docker compose up --build -d; bun run db:migrate; curl http://localhost:8787/healthz; bun run test; bun run typecheck; bun run lint; bun run build`

Expected: API and worker become ready, anonymous fixture upload is accepted once, public route exposes only reviewed aggregates, admin route rejects a missing session, and expiry removes a synthetic 31-day-old batch.

- [ ] **Step 6: Commit deployment and operations material.**

```powershell
git -C E:\WebstormProjects\simmtelemetryapi add Dockerfile docker-compose.yml src/ops docs
git -C E:\WebstormProjects\simmtelemetryapi commit -m "docs: add telemetry platform operations runbook"
git -C E:\WebstormProjects\simmwebclient add src/data/publicData.ts src/pages/PrivacyPage.tsx
git -C E:\WebstormProjects\simmwebclient commit -m "docs: publish implemented telemetry privacy boundary"
```

## Implementation order and acceptance gates

1. Complete Tasks 1–3 and deploy only to a private test environment; SIMM upload remains unavailable.
2. Complete Task 4 and seed only administrator-created canonical records; public results stay fixture-backed until the API contract tests pass.
3. Complete Tasks 5–7 and run the public web client plus admin console against test data; review role boundaries with two distinct test users.
4. Complete Task 8 and invite a small set of explicit opt-in testers; inspect only safe intake metadata and ensure no rejection code needs raw payload access.
5. Complete Task 9, run a retention sweep against test data, then enable the production upload base URL in a SIMM release.

## Self-review

- **Scope coverage:** The plan covers the standalone ingestion server, durable SIMM uploader, public web APIs, a fully authenticated administrative backend and console, canonical record management, warning publication, source aliases, creator claims, auditability, retention, and operations.
- **Privacy coverage:** Every telemetry endpoint is anonymous; any account-bearing endpoint is role-protected and operates from the separate `app` schema. The planned server persists no telemetry message/excerpt and publishes no raw telemetry fields.
- **Contract coverage:** Schema version, strict field validation, body/session/event caps, idempotent retry, client fixture conformance, and public DTO compatibility are explicit before upload is enabled.
- **No automatic safety claims:** Aggregates are evidence for review; status publication stays administrative until an approved policy exists.
- **Placeholder scan:** No task depends on an unspecified service, table, route, role, or test command. Payment-provider integration and self-service account registration are deliberately outside this telemetry/admin release; the existing sign-in page remains an account-access surface until a separate billing/account plan selects those providers.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-13-telemetry-platform-and-admin-backend.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
