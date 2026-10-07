# ![Synloquent by gogoSpace. BETA. Define in Laravel. Work offline in React Native.](docs/assets/readme-hero.svg)

Define your data model in Laravel. Generate typed bindings, read and edit local SQLite data in React Native, then synchronize with the server.

Synloquent connects explicitly exported Eloquent models to an offline TypeScript client. Laravel owns authorization and canonical data. The client commits local changes together with durable synchronization intent, including deletions.

[Quickstart](#quickstart) · [Documentation](#documentation) · [Development](docs/development.md) · [TODO](#prioritized-todo) · [MIT license](LICENSE)

> [!NOTE]
> **0.1.0 beta.** The API and local storage format are experimental. Local archives are included, with no npm or Packagist publication. Start with development data and review the compatibility limits before adopting an existing database.

## How it works

1. **Export from Laravel.** Declare fields, relations and operations for authenticated actors.
2. **Generate one file.** Artisan produces schema metadata and typed model, command and scope bindings.
3. **Work locally.** Query SQLite, edit records and observe committed changes without a network connection.
4. **Synchronize explicitly.** Push pending operations and pull authorized canonical changes. A local save and server acceptance are separate outcomes.

The packages are `synloquent/laravel` and `@synloquent/client`, both version `0.1.0`. The portable TypeScript core has no runtime dependencies. React subscriptions, asynchronous SQLite, native hashing and React Native composition use separate public entrypoints.

## Requirements

| Component            | Tested version                                            |
| -------------------- | --------------------------------------------------------- |
| PHP                  | 8.4.7 with PDO for the chosen database                    |
| Laravel              | 12.55.1 and 13.34.0, example uses 13.34.0                 |
| Server database      | MariaDB 11.7.2 or PostgreSQL 18.3                         |
| Node.js              | 22.21.1, minimum 22.13                                    |
| React Native / React | 0.87.1 / 19.2.8 with Hermes                               |
| OP-SQLite            | 18.2.5                                                    |
| Native tools         | JDK 21 and Android SDK, or macOS with Xcode and CocoaPods |

MariaDB works through Laravel's `mariadb` and `mysql` connection labels. This does not claim Oracle MySQL support. See [compatibility](docs/guides/compatibility.md) for database configuration and exact boundaries.

## Quickstart

The included example is a small product catalog. Create a notebook and bottle offline, update the notebook, restart the app, synchronize, then delete the synchronized bottle offline and restart again before sending the deletion.

From the repository root:

```sh
npm ci --ignore-scripts --no-audit --no-fund
php scripts/setup-example.php
composer install --working-dir=examples/laravel --no-interaction --prefer-dist
npm ci --prefix=examples/react-native --no-audit --no-fund
```

Create a dedicated MariaDB database and set its credentials in `examples/laravel/.env`, following the [installation guide](docs/guides/installation.md). Then:

```sh
php examples/laravel/artisan migrate --force
php examples/laravel/artisan synloquent:seed-example
php examples/laravel/artisan synloquent:doctor
php examples/laravel/artisan synloquent:generate --output=examples/react-native/backend.generated.ts
php examples/laravel/artisan serve --host=127.0.0.1 --port=8769
```

Leave Laravel running. In another terminal, start Metro with `npm start --prefix=examples/react-native`, then run `npm run android --prefix=examples/react-native`. For iOS, first run `pod install` in `examples/react-native/ios`, then `npm run ios --prefix=examples/react-native`. The [native walkthrough](examples/react-native/README.md) explains toolchain setup and the offline steps.

The examples install the exact local archives listed in [distribution.json](artifacts/packages/distribution.json). Do not repack them just to run the demo. Android emulators reach the host at `10.0.2.2:8769`, and the iOS simulator uses `127.0.0.1:8769`. The example uses local demonstration credentials, not a production login flow.

With an initialized client, local edits and explicit synchronization look like this:

```ts
const product = await client.models.Item.create({
  title: 'Notebook',
  price: '12.50',
  quantity: 1,
})

product.fill({ quantity: 2 })
await product.save()

await client.sync.flush()
await client.sync.pull('catalog')

const products = await client.models.Item.orderBy('title').get()
```

Use the generated `backendSchema` with `createReactNativeClient`, a stable account and device session, secure identity generation and request-bound authentication. The [example source](examples/react-native/src/Demo.tsx) shows the complete setup. Server policies remain authoritative.

## Documentation

- [Installation and local database setup](docs/guides/installation.md)
- [Laravel exports, authorization and transactional writes](docs/guides/laravel.md)
- [TypeScript queries, local edits and subscriptions](docs/guides/client.md)
- [Synchronization, conflicts and recovery](docs/guides/sync-recovery.md)
- [Compatibility and database constraints](docs/guides/compatibility.md)
- [Wire protocol](docs/PROTOCOL.md)
- [Native example walkthrough](examples/react-native/README.md)
- [Development and testing](docs/development.md)
- [Versions and dependency decisions](docs/adr/0001-supported-versions.md)

## Prioritized TODO

1. Stabilize the public API and provide explicit upgrade paths for local databases and generated bindings.
2. Improve large snapshot imports and document measured memory and responsiveness limits on representative physical devices.
3. Expand end-to-end coverage of relations, account changes, conflicts and recovery across more real application schemas.
4. Broaden the supported database and native version matrix, including a separate Oracle MySQL qualification.
5. Prepare registry releases, release automation and a concise migration guide for early adopters.

## Known limits

- Support is limited to the versions above. The native example is validated on an Android emulator and an iOS simulator, not a broad physical-device matrix.
- Large imports and production-scale performance are not qualified. Native fetch buffers response bodies, so multipart snapshots do not imply bounded memory for an arbitrary response.
- Generated bindings depend on the actual host schema. Regenerate and rebuild when changing the database engine or exported schema.
- Custom PHP scopes, casts and accessors execute on Laravel. Local object-JSON containment and arbitrary raw SQL are unsupported.
- Host applications must implement real authentication, actor and tenant scoping, policies and the documented write-capture contract. The example's synthetic tokens are for local development only.
- Some database prefix combinations and overlapping cascades are outside the tested contract. Review [compatibility](docs/guides/compatibility.md) before connecting an existing schema.
