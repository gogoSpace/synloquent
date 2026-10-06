import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repository = resolve(import.meta.dirname, '..')
const nativePackage = resolve(repository, 'examples/react-native/node_modules/react-native')
const metadata = JSON.parse(readFileSync(resolve(nativePackage, 'package.json'), 'utf8'))
if (metadata.version !== '0.87.1') throw new Error('Declaration repairs require exact React Native0.87.1')
const patches = [
  {
    path: 'types_generated/Libraries/Animated/nodes/AnimatedProps.d.ts',
    before: '[key: string]: true | AnimatedStyleAllowlist',
    after: '[key: string]: true | AnimatedStyleAllowlist | undefined',
  },
  {
    path: 'types_generated/Libraries/Lists/VirtualizedList.d.ts',
    before: 'React.ComponentRef<VirtualizedListType>',
    after: 'InstanceType<VirtualizedListType>',
  },
  {
    path: 'types_generated/src/private/webapis/dom/nodes/ReadOnlyNode.d.ts',
    before: 'get textContent(): string',
    after: 'get textContent(): string | null',
  },
]
const registered = JSON.parse(readFileSync(resolve(repository, 'scripts/rn-type-repairs.json'), 'utf8'))
for (const patch of patches) {
  const filename = resolve(nativePackage, patch.path)
  const source = readFileSync(filename, 'utf8')
  const digest = createHash('sha256').update(source).digest('hex')
  const expected = registered[patch.path]
  if (!expected || ![expected.original, expected.repaired].includes(digest)) throw new Error('Upstream declaration changed: ' + patch.path)
  if (digest === expected.repaired) continue
  if (source.split(patch.before).length !== 2) throw new Error('Repair must identify one exact declaration: ' + patch.path)
  const repaired = source.replace(patch.before, patch.after)
  if (createHash('sha256').update(repaired).digest('hex') !== expected.repaired) throw new Error('Unexpected repair result')
  writeFileSync(filename, repaired)
}
console.log('Exact React Native declaration repairs verified without checker suppression')
