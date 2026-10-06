# Pinned React Native declaration repairs

React Native 0.87.1 includes three TypeScript declaration issues encountered by the strict example build. `scripts/repair_rn_types.mjs` applies exact content-addressed fixes registered in `scripts/rn-type-repairs.json`.

The repair accepts only the expected original or already repaired declaration hashes. Unexpected upstream content fails instead of being patched heuristically. The changes affect declarations rather than runtime JavaScript. Type checking keeps `skipLibCheck` disabled.

The example runs this repair after dependency installation. Another React Native version requires separate compatibility work and updated declaration review.
