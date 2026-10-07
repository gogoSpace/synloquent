# Development and testing

Use the pinned lockfiles and the toolchains in the [installation guide](guides/installation.md). Package source development requires the workspace dependencies and `composer install --working-dir=packages/laravel` in addition to the example setup.

## TypeScript and protocol

From the repository root:

```sh
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:protocol
npm run typecheck --prefix=examples/react-native
```

The core tests use real Node SQLite adapters. Protocol tests validate shared JSON schemas and fixtures. These checks do not establish native performance.

## Laravel

Create a disposable local database whose name begins with `synloquent_`. Set `SYNLOQUENT_TEST_CONNECTION` to the JSON connection configuration expected by `packages/laravel/tests/Fixtures/database.php`. For MariaDB, for example:

```sh
export SYNLOQUENT_TEST_CONNECTION='{"driver":"mariadb","host":"127.0.0.1","port":3306,"database":"synloquent_test","username":"synloquent_test","password":"your-test-password","charset":"utf8mb4","collation":"utf8mb4_unicode_ci","timezone":"+00:00","strict":true,"engine":"InnoDB","prefix":""}'
composer --working-dir=packages/laravel test
composer --working-dir=packages/laravel lint
composer --working-dir=packages/laravel analyse
```

Use `driver=pgsql`, PostgreSQL credentials, `charset=utf8`, `search_path=public` and `timezone=UTC` for PostgreSQL. Tests mutate and reset the selected database. Never use an existing application database. Formatting and static analysis do not need the test database.

## Package and schema changes

Generate bindings from the configured example host with `synloquent:generate`. The `--check` option verifies that the bundled file matches the current host. Rebuild the TypeScript package before packing a changed client.

```sh
python3 scripts/pack_client.py
python3 scripts/pack_server.py
```

The client packer updates the native example archive dependency and lock. After repacking the server, update the example's Composer package repository `dist.url` and SHA-1 checksum, then run `composer update synloquent/laravel --working-dir=examples/laravel`. `distribution.json` records SHA-256 for both packages. Keep release versions, archive metadata, locks and documentation aligned. Do not edit previously released migrations.

## Native walkthrough

Run the [example walkthrough](../examples/react-native/README.md) on each platform. Use the actual distributed package and a fresh dedicated database. Check pending operations before and after an actual process restart, then inspect the final server records. The example exposes a compact diagnostic state for that purpose.

For a self-contained Android build, use the example's Gradle wrapper with `:app:assembleRelease`. The bundle task explicitly tracks the installed Synloquent package to invalidate cached JavaScript when it changes. For iOS, select the `SynloquentExample` scheme and a Release simulator build in Xcode. The example's Android release uses the standard development signing key and is not a store distribution artifact.
