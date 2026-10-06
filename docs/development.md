# Development and testing

Use the pinned dependency locks and the toolchains listed in the [installation guide](guides/installation.md). Keep test databases separate from application data.

## TypeScript and protocol

From the repository root:

```sh
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:protocol
```

The core tests use real Node SQLite adapters. The protocol tests validate shared JSON schemas and fixtures. These checks do not establish React Native timing or memory behavior.

## Laravel

From the repository root:

```sh
composer --working-dir=packages/laravel test
composer --working-dir=packages/laravel lint
composer --working-dir=packages/laravel analyse
```

The PostgreSQL tests use `SYNLOQUENT_TEST_DATABASE`, with a default dedicated test database named `synloquent_test`. Configure a disposable database and the expected host, port and credentials before running them. Read `packages/laravel/tests/TestCase.php` for the exact connection defaults. Never point these tests at an existing application database.

## Real HTTP integration

```sh
npm run test:integration
```

This test creates an isolated synthetic PostgreSQL database, runs Laravel HTTP and checks a real local SQLite client. It needs PostgreSQL command-line tools, PHP, installed Laravel example dependencies and the TypeScript build. The existing test fixture defaults to PostgreSQL at `127.0.0.1:55432`, role `synloquent`. This is separate from the demonstration cluster on `55433`.

Use `SYNLOQUENT_POSTGRES_BIN` for a directory containing PostgreSQL commands when they are not on PATH. Development reports go to `.local/test-results` and are ignored by Git. The fixture creates and drops its own database.

## Package and schema changes

Run `python3 scripts/sync_protocol.py` when updating protocol schemas. Run `python3 scripts/check_generation.py` against the configured synthetic host to verify generation parity. Rebuild the TypeScript package before creating a new archive. Existing packers update the corresponding distribution identity, and the client packer also refreshes the example's local archive dependency.

Only repack when changing package contents. Keep archived package versions, generated bindings and examples consistent. Native testing requires the actual Android and iOS toolchains and remains distinct from Node tests.
