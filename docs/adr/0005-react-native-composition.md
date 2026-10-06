# Optional React Native composition

The `@synloquent/client/react-native` entrypoint composes the asynchronous SQLite adapter, native hashing, application scheduling and validated HTTP transport. Applications supply generated schema, a session, secure identity generation and request-bound authentication.

Account and tenant identifiers do not create credentials. The host authenticates each request and checks actor scope. Session changes coordinate cancellation and database ownership before rebinding the client. Closing the runtime cancels outstanding work and disposes the owned resources.

The lower-level core, React, SQLite and native crypto entrypoints remain available for applications that already own their platform composition. They must coordinate lifecycle and session changes themselves.

See [client configuration](../guides/client.md) and the [ordinary example](../../examples/react-native/src/Demo.tsx).
