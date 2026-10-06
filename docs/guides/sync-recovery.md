# Durability, confirmation and recovery

A create, update or save completes when the local data and outbox intent commit together. model.syncState distinguishes pending, synced, rejected and conflicted. Dirty attributes describe the current draft, while pending intent is a durable operation that can survive an application restart.

```ts
const item = await client.models.Item.findOrFail(1)
item.fill({ title: 'Updated title' })
await item.save()
await client.sync.flush()
```

For explicit server confirmation, use saveConfirmed or sync.confirmed with model.lastOperationId. A confirmation timeout preserves uncertainty. It does not authorize replacing the operation ID or repeating a business effect with a new ID.

The first attempted payload is immutable. Network loss after server commit is recovered by retrying the same operation. The server checks its account/device/epoch ownership and payload hash before replaying the stored receipt. Historical receipts and relation projections are reauthorized.

Pull updates canonical state without erasing local proposals. Rejected validation and stale revisions remain visible. Resolve a conflicted operation explicitly with sync.resolveConflict(operationId,'discard') or sync.resolveConflict(operationId,'retry',replacementValues). Retry creates a new intent against the current canonical revision. sync.cancel is available only while the original operation has not been attempted.

Local transactions publish one committed view and roll back data plus intent together. Nested work must use the supplied scoped transaction handle. Remote atomic groups are bounded declarative operations with causal references and a durable group identity. A JavaScript callback is never sent to PHP.

Pivot delta intents preserve unrelated remote membership. Complete-set sync requires complete canonical membership and its current relation revision. An empty complete set removes obsolete canonical membership, while outstanding local pivots overlay it until a receipt resolves them.

Use sync.resnapshot('catalog') for a complete registered dataset, sync.pull('catalog') for its tail and sync.updateManifest('catalog') for compatible online evolution. Snapshot verification covers canonical records plus relationSets, exact UTF8 bytes and SHA256. Schema identity, dataset, authorization scope and snapshot generation are validated separately. Installation commits through the same database owner and preserves pending edits and stable aliases.

A failed snapshot or migration leaves the old committed generation usable. Retention expiry requires a fresh authorized snapshot. Revoked rows and their relations stop being visible. Private unsent proposals are retained as recovery records rather than promoted into canonical data.

Account changes, logout and database replacement invalidate earlier model handles and in-flight responses. Requery models after a generation change. Cache primitive IDs before closing a client when a later reopen must locate the same entity. Subscriptions must be cancelled or disposed during unmount and close.

The server transactional outbox runs effects after commit. A destination supporting the declared idempotency key can reconcile retry after success followed by worker death. A destination without that mechanism has at-least-once delivery. Both behaviors have separate real-process control tests.
