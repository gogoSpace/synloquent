# @synloquent/client

Offline SQLite CRUD, explicit Eloquent-style queries and durable synchronization using generated Laravel exports.

Import the runtime core from `@synloquent/client`, React subscriptions from `@synloquent/client/react` and the native adapter from `@synloquent/client/sqlite`. Native qualification and performance evidence are recorded separately for iOS and Android in the repository acceptance artifacts.

Generate one TypeScript file with `php artisan synloquent:generate --output=backend.generated.ts` in your Laravel host. Copy it into your RN application and use its `backendSchema` to create the client. Laravel export declarations define the available fields and relations.

See the repository installation and client guides for driver setup, injected transport/session contracts, conflict recovery and supported versions. Local save completion means durability on the device. Confirmation is a separate operation.

For React Native0.87.1, install the optional peers @op-engineering/op-sqlite18.2.5 and scheduler0.27.0 alongside React19.2.8. Run the normal native autolinking, CocoaPods and Android build steps. The package includes its SHA256 native module and codegen specification.

The optional `@synloquent/client/react-native` entrypoint composes the async SQLite adapter, native SHA256 provider, application RuntimeScheduler and validated HTTP transport. Your application supplies authentication, the account and tenant session, and secure unique identity generation.

```ts
import type { Session } from '@synloquent/client'
import {
  createReactNativeClient,
  type ReactNativeHttpConfiguration,
} from '@synloquent/client/react-native'
import {
  backendSchema,
  type BackendModels,
  type BackendCommands,
  type BackendScopes,
} from './backend.generated'

export function openCatalog(
  session: Session,
  authenticate: ReactNativeHttpConfiguration['authenticate'],
  generateIdentity: () => string,
) {
  return createReactNativeClient<BackendModels, BackendCommands, BackendScopes>(
    {
      schema: backendSchema,
      database: { name: 'catalog.sqlite' },
      session,
      generateIdentity,
      http: {
        endpoint: 'https://api.example.com/synloquent/v1/protocol',
        authenticate,
        timeoutMilliseconds: 30000,
      },
    },
  )
}
```

The authentication callback receives the immutable request identity and a portable cancellation lifecycle. Return `{ session, headers }` from your credential provider, with the exact account, tenant, device, device epoch and generation belonging to those credentials. The callback may subscribe to cancellation to stop its own lookup. The transport rejects stale authentication and responses, validates request/schema identity and HTTP status, and applies its deadline while waiting for authentication as well as the response. It stops awaiting non-cooperative credential work when cancelled.

Use `runtime.client` for queries, offline writes and `runtime.client.sync.flush()`. Use `await runtime.setSession(nextSession)` when the authenticated session changes and `await runtime.close()` when its owner is disposed. Both operations coordinate HTTP cancellation with the serialized database owner. Direct lifecycle calls on the factory's client use the same coordinator. Changing session or closing from a scoped client transaction rejects before a nested lifecycle wait.

The separate `createReactNativeHttpTransport(configuration)` returns `{ transport, setSession, suspend, cancelPending, close }` for applications that already compose the core themselves. Such applications must coordinate its binding with their database lifecycle. React Native fetch buffers the response before cooperative JSON decoding and shape validation. This transport does not provide a streaming response or a bounded whole-document memory claim.
