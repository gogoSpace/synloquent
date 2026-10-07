# TypeScript client

Synloquent queries an authorized SQLite projection and records durable mutation intents. The Laravel package decides authorization, validation, canonical values and revisions. Generate the schema and TypeScript bindings from the host application before creating a client. The core package imports no React, React Native, Node or DOM runtime APIs.

## Open one database owner

For a React Native application, install the local client archive named in `artifacts/packages/distribution.json` and the selected optional peers. Replace the absolute checkout path below with your own path and use the archive identity recorded in that file. The package is not published to a registry. Run these commands from your RN application's root. The optional native crypto entrypoint is part of this package and autolinks into the host application.

```sh
npm install "/absolute/path/to/synloquent/artifacts/packages/synloquent-client-0.1.0-eaa8a74731c5329a.tgz" @op-engineering/op-sqlite@18.2.5 scheduler@0.27.0
(cd ios && USE_HERMES=1 pod install)
```

```ts
import { createSynloquent } from '@synloquent/client'
import { createDatabaseAdapter } from '@synloquent/client/sqlite'
import { createNativeCryptoProvider } from '@synloquent/client/native-crypto'
import {
  backendSchema,
  type BackendModels,
  type BackendCommands,
  type BackendScopes,
} from './backend.generated'

const crypto = createNativeCryptoProvider({
  yieldToApplication,
})

const client = await createSynloquent<
  BackendModels,
  BackendCommands,
  BackendScopes
>({
  schema: backendSchema,
  database: createDatabaseAdapter({ name: 'catalog.sqlite' }),
  session: {
    accountId: authenticatedAccountId,
    tenantId,
    deviceId,
    deviceEpoch,
    generation: sessionGeneration,
  },
  transport,
  generateIdentity,
  now: utcNow,
  digest: crypto.digest,
  digestChunks: crypto.digestChunks,
  schedule,
})
```

The optional SQLite entrypoint opens the named native database. `DatabaseAdapter` provides asynchronous `execute`, an owned `transaction` callback, scoped nested transactions, capabilities and `close`. Each transaction executor carries its own nested transaction method. Call the supplied scoped client inside `client.transaction` to enter a savepoint. Calling the outer client from inside its transaction callback queues behind that callback.

The injected transport implements `manifest`, `query`, `push`, `pull`, `snapshot` and `command`. It adds credentials, performs HTTP requests and validates protocol envelopes. The server authenticates the actor independently of the session's account identifier. Never use a shared unauthenticated snapshot URL as an authorization boundary.

The native crypto provider hashes exact UTF-8 bytes with system SHA256 on a serial native worker. It uses bounded buffers and accepts the application's measured scheduling boundary. Supply a fair `yieldToApplication` implementation and use the same scheduling policy during large imports. On bridgeless React Native, a zero-delay timer can wait for a frame. The qualified example uses the supported native scheduler and records full application frame coverage. Pure JavaScript hash implementations remain useful for small fixtures and independent correctness checks.

## Read and query

```ts
const item = await client.models.Item.findOrFail(42)
const rows = await client.models.Item.where('active', true)
  .whereBetween('price', ['5.00', '20.00'])
  .with('category', 'images')
  .orderBy('price')
  .get()

const titles = rows.pluck('title')
const page = await client.models.Item.cursorPaginate(50)
```

Builders are immutable. `where`, `orWhere`, grouped callbacks, negation, column comparisons, membership, null checks and ranges bind values. Ordering adds the public primary key as a stable tie breaker. `select` narrows public attributes and direct field reads to the chosen fields. A later `select` replaces that projection, and `addSelect` extends it. Pages, iterators and subscriptions preserve the same selected types. Predicates can use every declared readable field, and mutation methods still accept the declared writable fields. Identity and relation keys remain available internally for association and hydration. `distinct` chooses the lowest public primary key representative before ordering and pagination.

`LIKE` is case sensitive with `%` and `_` wildcards and backslash escapes. Local SQLite uses an equivalent bound GLOB pattern so driver pragma settings do not change results. Equality and string ordering use binary semantics. Unicode `_` matches one code point. Portable JSON predicates support scalar membership in a top-level array and a bounded scalar path. JSON null membership differs from SQL NULL. Object containment requires an explicitly registered remote scope.

```ts
await client.models.Item.whereJsonContains('labels', null).get()
await client.models.Item.whereJsonPath(
  'metadata',
  '$.region',
  'synthetic',
).get()
await client.scopes.metadataContains({ value: { region: 'synthetic' } }).get()
```

Explicit joins use declared models and fields. Joined predicates name a declared alias. Correlated subqueries allow scalar selects, comparisons and existence checks. Scalar subqueries require one selected field or aggregate and at most one row. Unions require the same resource and projection shape. Computed subquery values are read-only `model.projections`. Relation aggregates are read-only `model.aggregates`. These values are separate from canonical writable attributes.

`chunk`, `chunkById`, `lazy`, `lazyById` and `cursor` bound each page. Keyset variants continue after the previous identity even when a prior row disappears. Iteration reads committed data between pages. Cursor pagination binds its cursor to the builder, ordering, schema, partition, authorization scope and snapshot generation. Reusing a cursor after one of these changes fails with `cursor_expired`.

## Completeness

A local database without a complete scope is partial. A completed pull scan does not itself establish complete dataset membership. Collections carry `completeness`. Scalar methods such as `count`, `exists`, `sum` and pagination totals reject partial datasets by default.

```ts
const partialCount = await client.models.Item.allowPartial().count()
const result = await client.models.Item.aggregateResult('count')
// result.value and result.completeness
```

Use `allowPartial` only when a partial answer is acceptable. Complete-set pivot replacement requires both complete canonical membership and its current relation revision.

## Drafts and durable writes

```ts
const draft = client.models.Item.new({ title: 'Offline product' })
draft.fill({ quantity: 1, price: '12.50' })
await draft.save()
await client.sync.flush()
await draft.refresh()
```

A new draft has `exists === false` and dirty fields. `fill` and `forceFill` change that draft. Both enforce the exported writable projection. Neither bypasses authorization or permits writing read-only materialized fields. `save` atomically writes the visible proposal and immutable outbox intent. It does not imply that the server accepted the operation.

`getOriginal`, `getChanges`, `isDirty`, `isClean` and `wasChanged` describe the local instance's save history. `canonicalRecord` describes the last accepted server base. `fresh` returns a new current instance and `refresh` updates the current one. `replicate` removes identity and timestamps and returns an unsaved draft. Declared defaults and timestamps apply locally.

Integer keys use stable local identities until receipt or authoritative snapshot alias assignment. Related foreign keys and pivot targets use tagged references while offline. Alias installation remaps dependent rows and outbox references atomically. Never infer identity from a natural unique field. For UUID, ULID and custom string primary keys, provide the declared writable key when creating offline records.

Decimals are wire strings, including writes, ordering and exact sums. Unsafe integers are exact integer strings. Integer strings use canonical digits without leading zeros or a leading plus sign. Signed string zero `'-0'` is rejected, while `'0'` and numeric zero are accepted. JavaScript numbers must be finite and integer numbers must be safe. Integer sums return a number when safe and a string otherwise. Grouped SUM and AVG reduce canonical values with exact integer/decimal arithmetic. `aggregateGroups` preserves scope completeness, and exact numeric strings can be used as `$aggregate` HAVING thresholds. Dates use `YYYY-MM-DD`, datetimes use UTC strings and JSON contains wire scalars, arrays and objects. Enum values come from the generated schema. A server materialized append is `undefined` on an offline draft until canonical acceptance. PHP casts and accessors execute on the server.

```ts
await draft.increment('quantity', 2)
await draft.decrement('quantity')
await client.sync.confirmed(draft.lastOperationId!)
await draft.refresh()
```

Deltas are durable revision-checked operations on exported integer or float fields. Integer proposals remain exact. A stale revision produces an explicit conflict rather than a blind overwrite.

`create`, `firstOrNew`, `firstOrCreate`, `updateOrCreate`, `insert` and `upsert` are available on bindings and builders. Upsert requires an explicitly exported unique constraint. Bulk insert, upsert, update and delete use one atomic group with at most 100 entities. They capture selected membership and revision checks. Bulk intents carry `eventMode: 'bulk'`. Laravel applies casts, policies, timestamps and capture while bypassing instance model events, as Eloquent bulk builders do. The host database remains authoritative for concurrent uniqueness.

## Relations and soft deletes

```ts
await item.load('images', 'tags')
await item.loadMissing('category')
const category = item.relation('category').current?.first()

await item.relation('tags').attach([tag], { position: 2 })
await item.relation('tags').updateExistingPivot(tag, { position: 1 })
await item.relation('tags').detach([tag])
```

Reading a relation property performs no hidden I/O. Use `with`, constrained `with`, `load`, `loadMissing` or explicit relation `get`. Includes batch across parent collections. Relation queries use reflected custom foreign/local keys, through keys, explicit morph maps and deterministic one-of-many aggregate ordering. Morph predicates require an exported target model from the declared map.

Pivot relations support exported attributes and casts, `withPivot`, `wherePivot`, `orderByPivot`, attach, detach, toggle, update, sync and sync without detaching. Canonical membership and pending proposals are stored separately. Snapshot and pull ingestion replay pending pivot proposals in deterministic order. Empty canonical sets clear previous membership. A stale or incomplete complete-set replacement fails explicitly.

Relation create/save and their many variants assign reflected foreign and morph keys. Save-many and create-many use an owned local transaction. Declared cascade, restrict and nullify behavior is applied with durable parent intent before deferred SQLite constraint checks.

A nonprimary `ownerKey` retains its natural value when an integer primary key receives its server alias. Deferred SQLite foreign keys reference the declared unique owner key. Historical hidden rows release that key, while visible duplicates and orphans are rejected. Declared `onUpdate: 'cascade'` changes child overlays locally, then updates their canonical base when the parent is accepted. Independent child edits remain durable and may require a revision conflict retry.

An accepted owner-key change updates each authorized child's canonical foreign key even while a retained hard delete hides the parent. A later rejected or conflicted delete can be discarded against that accepted base. Explicit child reassociation, `null`, field edits and independent delete proposals remain separate. Revoked children stay hidden.

Soft-deleted models are excluded by default. Use `withTrashed` or `onlyTrashed`, then `restore` or authorized `forceDelete`. Pending lifecycle proposals survive resnapshots. Local hard-delete overlays are excluded from root, joined, relation and aggregate queries, including `withTrashed`. Confirmed dataset membership remains separate, allowing an unattempted delete cancellation or revision-conflict discard to restore still-authorized canonical records. A server physical deletion or authorization removal withdraws that membership.

New canonical children arriving through snapshot or pull inherit active cascade and nullify overlays before publication, including grandchildren and child-first record order. Rejected or conflicted deletes retain these overlays until explicit resolution. Dependency lookup uses the child's effective proposal. An explicit foreign-key reassociation or `null` remains intact. Natural-key updates are replayed before deletes, and a live replacement owner keeps children belonging to its reused key. Reflected indexes with the foreign key first support bounded descendant lookup.

## Remote execution, commands and conflicts

```ts
const remoteRows = await client.models.Item.remote().allowPartial().get()
const result = await client.commands.increaseQuantity(
  { item_id: 42, delta: 1 },
  immutableOperationId,
)
```

Remote `get`, `find` and `first` results are detached read views. Their types omit model and relation mutation methods, and runtime guards reject detached writes before changing drafts or durable state. Remote queries use the explicit transport and carry scope completeness. For an editable existing record, use `await client.models.Item.remote().firstOrNew({ id: serverIdentity })`, then `fill` and `save` or `saveConfirmed`. The helper fetches the full authorized canonical row regardless of a preceding `select`, materializes it through the existing atomic database owner, and retains local aliases and pending proposals. `remote().create()`, `firstOrCreate`, `updateOrCreate` and bounded bulk helpers remain editable entrypoints. Referenced authorized records must already be available through synchronization or explicit materialization when the local schema declares their foreign keys. A missing referenced row preserves the native integrity failure and rolls back the materialization. The helper does not fetch an implicit relation graph.

Remote lookup resolves a confirmed local identity to its public server key. An unconfirmed local identity has no remote record yet. Registered scopes and commands have generated argument and result types. Local execution of a server scope, transaction lock or unregistered SQL expression fails explicitly. Core never accepts raw SQL through the portable builder.

Generate a command's operation identity once outside the retry loop. The client stores its immutable payload before the request and reuses an accepted result. Reusing the identity with a different payload fails. Durable host effects and downstream idempotency are server responsibilities.

`saveConfirmed`, `createConfirmed` and `sync.confirmed` distinguish acceptance from a retained conflict or rejection. A timeout or lost response does not prove that the server write failed. Retry the same persisted intent. Once attempted, an operation payload is immutable. `cancel` applies only to an unattempted intent. Cancel explicit dependent operations before their prerequisite. Cancelling a hard delete rebuilds cascade and nullify overlays from current canonical membership and remaining outbox intent. Independent child proposals and other pending deletes remain. A child revoked by snapshot or pull stays hidden, including after restart. Resolve retained conflicts explicitly with `resolveConflict(operationId, 'discard')` or a fresh retry. Authorization removals move proposals to restricted `sync.recovery()` records.

## Snapshots, manifests and sessions

```ts
await client.sync.resnapshot('catalog')
await client.sync.pull('catalog')
await client.sync.updateManifest('catalog')
await client.setSession(nextSession)
await client.close()
await crypto.close()
```

Offline boot uses the cached validated manifest. Compatible online changes add projected fields, relations or resources and backfill an authenticated immutable snapshot in one active-database transaction. Breaking field changes and unknown required engine capabilities require an upgrade. Schema, dataset, generation and authorization metadata are checked separately from content integrity.

Snapshot hash and byte size cover canonical JSON of `{ records, relationSets }`. Large snapshots require injected `digestChunks`. Core emits coalesced chunks of at most 4096 UTF-8 bytes without splitting surrogate pairs. The digest consumer must drain the stream, hash exact UTF-8 bytes and provide a fair application scheduling boundary. Both digest callbacks receive an optional structural `DigestLifecycle` with `cancelled` and `subscribe`. Close, session changes and newer snapshot verification cancel pending work. A provider must release its own contexts when cancelled. Late completion cannot activate a previous generation. The optional native provider implements this contract and has its own `close` for application shutdown. The optional phase observer reports validation, digest, staging, records, relation sets, integrity and commit. Diagnostic exceptions cannot change transaction outcomes.

`downloadUrl` is optional metadata for an authenticated immutable document. Core never fetches that URL. A transport may implement an explicit download with its normal credentials and an allowlisted origin.

The bundled RN transport requests the bounded `parts-v1` representation. Deploy its matching Laravel package before using the new client. Each part contains at most 256 complete rows and 65,536 UTF-8 bytes. A response groups at most 16 parts within 1 MiB, and the client decodes and stages one part at a time. It checks the complete original catalog digest before atomic activation. Interrupted acquisition can resume without replacing the active catalog or losing pending intent. An oversized single record or relation set fails admission explicitly. The new transport does not silently fall back to a whole snapshot on an older backend.

Native memory observations adjust bounded work through the portable budget policy. Unknown or stale observations use conservative limits, pressure reduces new work promptly and recovery uses hysteresis. Android system availability is advisory and does not prove application headroom. The RN factory closes its native observations with the client. Application-owned policy providers and crypto contexts need their own lifecycle cleanup. The RN receive bound relies on the matching backend enforcing response geometry because its supported fetch implementation buffers the response before exposing it to JavaScript.

One database owner serializes migrations, snapshot activation, partition changes and close. Pending creates, edits, lifecycle intents, aliases and outbox entries survive successful replacement. Invalid hashes, duplicate identities, constraints or integrity checks roll back data and cursor together. Reacquire models after replacement or call `fresh`/`refresh` within the same partition. Models and late network responses from another account, device, epoch or generation are rejected.

## Subscriptions and React

```ts
const subscription = client.observe(client.models.Item.where('active', true))
const unsubscribe = subscription.subscribe(renderFromSnapshot)
await subscription.refresh()
const snapshot = subscription.getSnapshot()
unsubscribe()
subscription.dispose()
```

The snapshot object remains stable between committed updates. Subscriptions publish committed query results. Last unsubscribe detaches the database listener, and `dispose` permanently releases the subscription. Dispose application-owned subscriptions when logging out. Database replacement invalidates old model instances and refreshes observed membership. Observe a model with a query constrained to its identity. The optional React entrypoint exposes `useSynloquentQuery`, cleans up on unmount and accepts generated client bindings. `Query.observationKey` includes its AST, execution mode, partial opt-in and current schema fingerprint. The hook observes the original query, preserving `.remote()` and `.allowPartial()`. React and native modules are absent from the core entrypoint.

## Limits

The native example uses the packed public SDK with Hermes and asynchronous OP-SQLite on Android and iOS. Node SQLite tests cover core behavior, but do not establish native timing or memory behavior. Large-import performance remains a beta limitation. Native fetch buffers the HTTP response before parsing and validation. Use representative application data to measure your own memory and responsiveness requirements.

See [compatibility](compatibility.md) for the supported versions and database boundaries, and [development](../development.md) for reproducible checks.
