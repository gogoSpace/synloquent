# Asynchronous native SQLite adapter

The React Native entrypoint uses OP-SQLite 18.2.5. Database execution is asynchronous, and one serialized owner coordinates transactions, close, session changes and snapshot activation. The portable core depends on the adapter contract rather than the native driver.

SQLite transactions provide atomic local edits and durable pending synchronization intent. Nested scoped work uses savepoints. Subscription changes publish only committed state and are disposed when their owner closes or changes session.

Native builds exercise a different runtime from Node SQLite tests. A synchronous Node adapter is useful for correctness testing but cannot establish Hermes timing, native memory usage or UI responsiveness.

The current pre-alpha has passed a small ordinary offline CRUD and synchronization workflow on an Android emulator and iOS simulator. Large-catalog import times and responsiveness remain open work. Driver throughput alone does not establish the cost of validation, hashing, staging, canonical activation and subscription work.

The adapter is behind `@synloquent/client/sqlite`. Applications should use the composed React Native factory or provide compatible scheduling, native hashing and transport boundaries themselves. See the [client guide](../guides/client.md).
