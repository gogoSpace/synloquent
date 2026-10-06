import { createSynloquent } from '../../src/index.js'
import { configuration } from '../fixtures.js'
const filename = process.argv[2]!
const phase = process.argv[3]!
const client = await createSynloquent(configuration(filename))
if (phase === 'before-commit')
  await client.transaction(async (transaction) => {
    await transaction.models.Item!.create({ name: 'Uncommitted child process' })
    process.send?.('ready')
    await new Promise<void>(() => {})
  })
else {
  await client.models.Item!.create({ name: 'Committed child process' })
  process.send?.('ready')
  await new Promise<void>(() => {})
}
