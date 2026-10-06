# React Native offline example

A small catalog using React Native 0.87.1, React 19.2.8, Hermes and OP-SQLite 18.2.5. The client is installed from the local npm archive and uses the public `createReactNativeClient` factory. Laravel generates the schema in `backend.generated.ts`.

Follow [installation](../../docs/guides/installation.md) first. The ordinary app opens the demo directly. Its HTTP endpoint is port `8769`, through `10.0.2.2` on Android or `127.0.0.1` on the iOS simulator.

## Offline edits and synchronization

Use a fresh application database and disposable Laravel database. The screen lists items whose titles start with `Pre-alpha`. Regular seeded items are outside this small walkthrough.

1. Stop your Laravel HTTP server. Keep Metro or the installed JavaScript bundle available.
2. Tap **Create A and B offline**. One local transaction creates both items with quantity 1.
3. Tap **Update A offline**. A becomes `Pre-alpha A updated` with quantity 2. B is unchanged.
4. Completely terminate the application process and reopen the same installation without deleting its data. A, B and pending operations should remain. Fast Refresh and backgrounding are not process restarts.
5. Start Laravel with the same database and keys, then tap **Sync with Laravel**. Verify both rows are `synced`, their server identities are assigned and pending changes are empty.
6. Stop Laravel, then tap **Delete B locally**. B disappears locally and its delete remains pending.
7. Completely terminate and reopen the same application again. A should remain, B should stay absent and the same pending delete should survive.
8. Start Laravel and synchronize. Confirm that A remains and B is absent on both the client and server.

Read the synthetic server data with:

```sh
psql --host=127.0.0.1 --port=55433 --username=postgres --dbname=synloquent_example --command="SELECT id, title, quantity FROM items ORDER BY id"
```

Local saves mean device durability, not server acceptance. Inspect row state, pending operations and server values instead of treating a common success message as acceptance of every operation. Do not reinstall the app or clear its database between restart steps.

This complete small A/B workflow has passed in an Android emulator and iOS simulator. It does not establish native relations, conflicts, schema backfill, physical devices or large-import performance. Use a separate synthetic server database per platform when repeating it so the fixed example titles do not collide.

## Application configuration

The demo uses public synthetic credentials for the local example. A real application must supply request-bound authentication and a correctly scoped session. It must own one runtime and close it when disposed. See [client configuration](../../docs/guides/client.md) and [recovery behavior](../../docs/guides/sync-recovery.md).
