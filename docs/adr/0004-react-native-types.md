# Exact React Native declaration repairs

Date:2026-10-02. Target:React Native0.87.1 with React19.2.8 and TypeScript5.9.3.

The native consumer uses React Native's generated strict public API and keeps strict=true, exactOptionalPropertyTypes=true, noUncheckedIndexedAccess=true and skipLibCheck=false. Its checker found three contradictions inside installed upstream declarations, reproduced independently of Synloquent model code.

The optional AnimatedPropsAllowlist.style permits undefined, while its string index signature omitted undefined. The repaired index includes that already-declared optional value.
VirtualizedListInstance used React.ComponentRef on a class constructor whose static getDerivedStateFromProps signature fails React19's ElementType constraint. InstanceType preserves the concrete instance of that same constructor.
ReadOnlyNode.textContent declared string, while its real ReactNativeDocument subclass overrides it with null. The base declaration now includes string|null, preserving the actual native document behavior.

scripts/repair_rn_types.mjs applies only those three substitutions. Original and repaired SHA256 identities are registered in scripts/rn-type-repairs.json. An unexpected version or source hash fails. This script changes declarations only and runs after native dependency installation. It introduces no runtime dependency, compiler suppression, any substitution or legacy API fallback.

The native tsconfig uses narrow type-resolution paths for optional peer modules imported by the native example. Runtime Metro resolution remains package based. Core continues to use ES2022-only types.

Primary reference: [React Native strict TypeScript API](https://reactnative.dev/docs/strict-typescript-api). Defect evidence comes from the exact installed0.87.1 declaration files registered by hash. Run `npm run typecheck --prefix=examples/react-native` after installing the native dependencies.
