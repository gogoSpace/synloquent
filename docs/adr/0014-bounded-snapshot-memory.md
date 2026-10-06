# Bounded snapshot transfer and memory budgets

The React Native HTTP transport requests the `parts-v1` snapshot representation from the matching Laravel package. Parts bound complete rows and UTF-8 content. The client validates, hashes and stages parts before atomic activation, preserving pending edits and the active generation during interrupted acquisition.

The portable core owns fixed work ceilings for temporary buffers, caches and batches. React Native supplies memory observations and pressure events. Missing or stale observations use conservative budgets. Pressure reduces rebuildable work without removing pending intent or weakening transaction integrity.

Native fetch can still buffer a complete response before parsing. Chunked database work and bounded representation do not create a whole-response streaming guarantee. Oversized records or relation sets fail admission rather than bypassing limits.

The implementation includes bounded policies, but large native imports and realistic pressure behavior remain open validation work. The small offline CRUD example is not a performance or memory-pressure guarantee. See [client behavior](../guides/client.md) and the roadmap in [README](../../README.md#prioritized-roadmap).
