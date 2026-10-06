import type {
  Query,
  QuerySnapshot,
  ReadonlyModelInstance,
  SynloquentClient,
} from '../src/index.js'

type Fields = {
  id: number | string
  name: string
  price: string
  active: boolean
  count: number | string
}
type WritableFields = Omit<Fields, 'id'>

export async function projectionTypeContract(
  query: Query<Fields, WritableFields, 'images' | 'tags'>,
  client: Pick<SynloquentClient, 'observe'>,
): Promise<void> {
  const empty = await query.select().firstOrFail()
  // @ts-expect-error An empty explicit selection promises no named public attributes.
  void empty.attributes.name
  const scalarPrice: string | undefined = await query
    .select('name')
    .value('price')
  void scalarPrice
  const selected = query.select('name').where('active', true).orderBy('price')
  const model = await selected.firstOrFail()
  const name: string = model.attributes.name
  const directName: string = model.name
  const selectedName: string = model.get('name')
  void name
  void directName
  void selectedName
  // @ts-expect-error An unselected field is absent from the public attributes type.
  void model.attributes.price
  // @ts-expect-error An unselected field is absent from direct property access.
  void model.price
  // @ts-expect-error get only reads the selected public view.
  model.get('price')
  model.fill({ price: '1.25' })
  model.set('count', 2)
  // @ts-expect-error Primary identity is not writable.
  model.fill({ id: 2 })
  const extended = await selected.addSelect('price').firstOrFail()
  const price: string = extended.attributes.price
  void price
  const replaced = await selected
    .addSelect('price')
    .select('active')
    .firstOrFail()
  const active: boolean = replaced.attributes.active
  void active
  // @ts-expect-error select replaces the old public projection.
  void replaced.attributes.name
  const addedFromFull = await query.addSelect('price').firstOrFail()
  // @ts-expect-error addSelect begins an explicit projection when none was selected.
  void addedFromFull.attributes.name
  for (const page of [
    await selected.paginate(),
    await selected.simplePaginate(),
    await selected.cursorPaginate(),
  ]) {
    const pageModel = page.data.first()!
    const pageName: string = pageModel.attributes.name
    void pageName
    // @ts-expect-error Every pagination variant preserves the selected fields.
    void pageModel.attributes.price
  }
  for (const iterator of [
    selected.lazy(),
    selected.lazyById(),
    selected.cursor(),
  ]) {
    for await (const entry of iterator) {
      const entryName: string = entry.attributes.name
      void entryName
      // @ts-expect-error Every iterator preserves the selected fields.
      void entry.attributes.price
    }
  }
  await selected.chunk(10, async (rows) => {
    const entryName: string = rows.first()!.attributes.name
    void entryName
    // @ts-expect-error Chunk callbacks preserve the selected fields.
    void rows.first()!.attributes.price
  })
  const observation = client.observe(selected)
  const snapshot: QuerySnapshot<
    Fields,
    WritableFields,
    'images' | 'tags',
    'name'
  > = observation.getSnapshot()
  const observedName: string = snapshot.data.first()!.attributes.name
  void observedName
  // @ts-expect-error Observations preserve projection rather than widening it.
  void snapshot.data.first()!.attributes.price
  observation.dispose()

  const remote = await selected.remote().firstOrFail()
  const readonlyRemote: ReadonlyModelInstance<
    Fields,
    WritableFields,
    'images' | 'tags',
    Pick<Fields, 'name'>
  > = remote
  void readonlyRemote
  const remoteName: string = remote.attributes.name
  void remoteName
  // @ts-expect-error Remote select remains narrowed.
  void remote.attributes.price
  // @ts-expect-error A detached read has no mutable fill method.
  remote.fill({ name: 'Detached mutation' })
  // @ts-expect-error A detached read has no mutable save method.
  remote.save()
  // @ts-expect-error A detached read has no mutable delete method.
  remote.delete()
  // @ts-expect-error Relations do not bypass the read facade.
  remote.relation('images').create({ url: 'Detached relation' })
  remote.relation('tags').constrain((provided) => {
    // @ts-expect-error Supplied detached constraints do not expose durable creation.
    provided.create({ label: 'Forbidden' })
    // @ts-expect-error Fluent chains retain the constraint-only surface.
    provided.where('label', 'value').create({ label: 'Forbidden chain' })
    // @ts-expect-error remote mode does not expose the intentionally editable remote create.
    provided.remote().create({ label: 'Forbidden remote chain' })
    // @ts-expect-error Supplied constraints do not grant the database owner.
    void provided.storage
    // @ts-expect-error Supplied constraints cannot execute queries returning editable models.
    provided.get()
    return provided
      .whereGroup((nested) => {
        // @ts-expect-error Nested callback queries retain the same constraint surface.
        nested.firstOrNew({ label: 'Forbidden nested' })
        return nested.where('label', '=', 'value')
      })
      .when(true, (nested) => {
        // @ts-expect-error Conditional callback queries retain the same constraint surface.
        nested.insert([{ label: 'Forbidden conditional' }])
        return nested.orderBy('label')
      })
      .withConstrained('items', (nested) => {
        // @ts-expect-error Eager nested callbacks cannot mutate through supplied queries.
        nested.update({ name: 'Forbidden eager' })
        return nested.select('name').where('active', true)
      })
  })
  // @ts-expect-error withPivot retains the detached relation facade.
  remote.relation('tags').withPivot('position').attach(['1'])
  // @ts-expect-error Direct relation maps retain the same facade.
  remote.relations.tags!.attach(['1'])
  const relatedRead = await remote.relation('images').first()
  // @ts-expect-error A loaded related model remains a detached read.
  relatedRead?.save()
  const refreshedRead = await remote.refresh()
  // @ts-expect-error Refresh cannot escape the read facade.
  refreshedRead.fill({ name: 'Detached refresh' })
  const loadedRead = await remote.load('images')
  // @ts-expect-error load cannot escape the read facade.
  loadedRead.save()
  const freshRead = await remote.fresh()
  // @ts-expect-error fresh cannot escape the read facade.
  freshRead?.delete()
  const remoteObserved = client.observe(selected.remote()).getSnapshot()
  // @ts-expect-error Remote subscriptions retain the detached facade.
  remoteObserved.data.first()!.save()
  const editable = await selected.remote().firstOrNew({ id: '1' })
  const fullPrice: string = editable.attributes.price
  void fullPrice
  editable.fill({ name: 'Explicit editing' })
  await editable.saveConfirmed()
  const created = await selected.remote().create({ name: 'Created' })
  await created.update({ price: '2.50' })
  const found = await selected.remote().firstOrCreate({ id: '1' })
  found.fill({ price: '1.00' })
  // @ts-expect-error Criteria are all fields but fill values remain writable fields.
  selected.remote().firstOrNew({ id: '1' }, { id: '2' })
}

export async function defaultScopeTypeContract(
  client: SynloquentClient,
): Promise<void> {
  const result = await client.scopes.registered!({}).firstOrFail()
  // @ts-expect-error Default registered scopes always return detached remote reads.
  result.save()
}
