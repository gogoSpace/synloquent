import assert from 'node:assert/strict'
import type {
  Query,
  QueryMode,
  Attributes,
  SynloquentClient,
  ModelInstance,
  Collection,
} from '@synloquent/client'
import { SynloquentError } from '@synloquent/client'
export interface PortableScenario {
  readonly name: string
  readonly methods: readonly string[]
  readonly run: (
    client: Pick<SynloquentClient, 'storage' | 'query' | 'sync'>,
    mode: 'local' | 'remote',
  ) => Promise<void>
}
function identities(
  models: Collection<{ readonly id: import('@synloquent/client').WireValue }>,
): string[] {
  return models.items.map((model) => String(model.id))
}
function base(
  client: Pick<SynloquentClient, 'query'>,
  mode: 'local' | 'remote',
  model = 'Item',
): Query<Attributes, Attributes, string, undefined, QueryMode> {
  const query = client.query(model)
  return mode === 'remote' ? query.remote().allowPartial() : query
}
export const portableReadScenarios: readonly PortableScenario[] = [
  {
    name: 'portable C02 identity retrieval and not-found boundaries',
    methods: [
      'C02.find',
      'C02.findOrFail',
      'C02.first',
      'C02.firstOrFail',
      'C02.get',
      'C02.all',
    ],
    async run(client, mode) {
      const query = base(client, mode)
      assert.equal((await query.find(1))?.attributes.title, 'Alpine stamp')
      assert.equal((await query.findOrFail(2)).attributes.title, 'River stamp')
      assert.equal(String((await query.first())?.id), '1')
      assert.equal(
        (await query.where('id', 3).firstOrFail()).attributes.title,
        'Forest stamp',
      )
      assert.deepEqual(identities(await query.get()), ['1', '2', '3'])
      assert.deepEqual(identities(await query.all()), ['1', '2', '3'])
      assert.equal(await query.find(999999), null)
      await assert.rejects(
        query.findOrFail(999999),
        (error) =>
          error instanceof SynloquentError && error.code === 'not_found',
      )
      await assert.rejects(query.where('id', 999999).firstOrFail(), /not found/)
    },
  },
  {
    name: 'portable C09 projections and stable distinct representative',
    methods: ['C09.select', 'C09.addSelect', 'C09.distinct'],
    async run(client, mode) {
      const query = base(client, mode)
      assert.deepEqual(
        Object.keys(
          (await query.select('title').firstOrFail()).toJSON(),
        ).sort(),
        ['id', 'title'],
      )
      assert.deepEqual(
        Object.keys(
          (
            await query.select('title').addSelect('price').firstOrFail()
          ).toJSON(),
        ).sort(),
        ['id', 'price', 'title'],
      )
      assert.deepEqual(
        identities(await query.select('price').distinct().get()),
        ['1', '2'],
      )
    },
  },
  {
    name: 'portable C10 bound comparison and grouped boolean construction',
    methods: [
      'C10.where',
      'C10.orWhere',
      'C10.groupedAnd',
      'C10.groupedOr',
      'C10.groupedNot',
      'C10.whereColumn',
    ],
    async run(client, mode) {
      const query = base(client, mode)
      assert.deepEqual(
        identities(await query.where('quantity', '>', 1).get()),
        ['2', '3'],
      )
      assert.deepEqual(
        identities(
          await query.where('quantity', 1).orWhere('quantity', 3).get(),
        ),
        ['1', '3'],
      )
      assert.deepEqual(
        identities(
          await query
            .whereGroup((group) =>
              group.where('active', true).where('quantity', '>', 1),
            )
            .get(),
        ),
        ['3'],
      )
      assert.deepEqual(
        identities(
          await query
            .whereGroup((group) =>
              group.where('quantity', 1).orWhere('quantity', 3),
            )
            .get(),
        ),
        ['1', '3'],
      )
      assert.deepEqual(
        identities(
          await query.whereNot((group) => group.where('active', true)).get(),
        ),
        ['2'],
      )
      assert.deepEqual(
        identities(await query.whereColumn('quantity', '=', 'quantity').get()),
        ['1', '2', '3'],
      )
    },
  },
  {
    name: 'portable C11 membership null and range operators',
    methods: [
      'C11.whereIn',
      'C11.whereNotIn',
      'C11.whereNull',
      'C11.whereNotNull',
      'C11.whereBetween',
      'C11.whereNotBetween',
    ],
    async run(client, mode) {
      const query = base(client, mode)
      assert.deepEqual(identities(await query.whereIn('id', [1, 3]).get()), [
        '1',
        '3',
      ])
      assert.deepEqual(identities(await query.whereNotIn('id', [1, 3]).get()), [
        '2',
      ])
      assert.deepEqual(identities(await query.whereNull('labels').get()), ['2'])
      assert.deepEqual(identities(await query.whereNotNull('labels').get()), [
        '1',
        '3',
      ])
      assert.deepEqual(
        identities(await query.whereBetween('quantity', [1, 2]).get()),
        ['1', '2'],
      )
      assert.deepEqual(
        identities(await query.whereNotBetween('quantity', [1, 2]).get()),
        ['3'],
      )
    },
  },
  {
    name: 'portable C12 ASCII LIKE and binary equality have explicit Unicode behavior',
    methods: [
      'C12.like',
      'C12.caseSensitiveComparison',
      'C12.unicodeComparison',
    ],
    async run(client, mode) {
      const query = base(client, mode)
      assert.deepEqual(
        identities(await query.where('title', 'like', 'aLPINE%').get()),
        [],
      )
      assert.deepEqual(
        identities(await query.where('title', 'like', 'Alpine%').get()),
        ['1'],
      )
      assert.deepEqual(
        identities(await query.where('title', 'alpine stamp').get()),
        [],
      )
      assert.deepEqual(
        identities(await query.where('title', 'Říční známka').get()),
        [],
      )
    },
  },
  {
    name: 'portable C13 scalar JSON arrays retain null and scalar type distinctions',
    methods: [
      'C13.jsonScalarArrayContains',
      'C13.jsonNullArrayContains',
      'C13.jsonScalarPath',
      'C13.unsupportedLocalObjectContains',
    ],
    async run(client, mode) {
      const query = base(client, mode)
      for (const scalar of [true, 1, 'synthetic'])
        assert.deepEqual(
          identities(await query.where('labels', 'jsonContains', scalar).get()),
          ['1'],
        )
      assert.deepEqual(
        identities(await query.where('labels', 'jsonContains', null).get()),
        ['1'],
      )
      assert.deepEqual(
        identities(
          await query
            .where('metadata', 'jsonPath', {
              path: '$.region',
              value: 'synthetic',
            })
            .get(),
        ),
        ['1', '2', '3'],
      )
      await assert.rejects(
        base(client, 'local')
          .where('metadata', 'jsonContains', { region: 'synthetic' })
          .get(),
        (error) =>
          error instanceof SynloquentError &&
          error.code === 'unsupported_query',
      )
    },
  },
  {
    name: 'portable C14 C15 explicit ordering stable ties and pagination bounds',
    methods: [
      'C14.orderBy',
      'C14.orderByDesc',
      'C14.reorder',
      'C14.latest',
      'C14.oldest',
      'C14.identityTiebreaker',
      'C15.limit',
      'C15.take',
      'C15.offset',
      'C15.skip',
    ],
    async run(client, mode) {
      const query = base(client, mode)
      assert.deepEqual(identities(await query.orderBy('quantity').get()), [
        '1',
        '2',
        '3',
      ])
      assert.deepEqual(identities(await query.orderByDesc('quantity').get()), [
        '3',
        '2',
        '1',
      ])
      assert.deepEqual(
        identities(await query.orderBy('quantity').reorder('id', 'desc').get()),
        ['3', '2', '1'],
      )
      assert.deepEqual(identities(await query.latest('quantity').get()), [
        '3',
        '2',
        '1',
      ])
      assert.deepEqual(identities(await query.oldest('quantity').get()), [
        '1',
        '2',
        '3',
      ])
      assert.deepEqual(identities(await query.orderBy('price').get()), [
        '2',
        '1',
        '3',
      ])
      assert.deepEqual(identities(await query.limit(1).get()), ['1'])
      assert.deepEqual(identities(await query.take(1).get()), ['1'])
      assert.deepEqual(identities(await query.offset(1).limit(1).get()), ['2'])
      assert.deepEqual(identities(await query.skip(1).take(1).get()), ['2'])
    },
  },
  {
    name: 'portable C16 scalar field/existence and exact aggregate results',
    methods: [
      'C16.value',
      'C16.pluck',
      'C16.exists',
      'C16.doesntExist',
      'C16.count',
      'C16.min',
      'C16.max',
      'C16.sum',
      'C16.avg',
    ],
    async run(client, mode) {
      const query = base(client, mode)
      assert.equal(await query.value('title'), 'Alpine stamp')
      assert.deepEqual((await query.pluck('title')).all(), [
        'Alpine stamp',
        'River stamp',
        'Forest stamp',
      ])
      assert.equal(await query.where('id', 1).exists(), true)
      assert.equal(await query.where('id', 999999).doesntExist(), true)
      assert.equal(await query.count(), 3)
      assert.equal(String(await query.min('price')), '7.25')
      assert.equal(String(await query.max('price')), '12.50')
      assert.equal(String(await query.sum('price')), '32.25')
      assert.equal(await query.avg('quantity'), 2)
    },
  },
  {
    name: 'portable C17 declared grouped aggregation and having',
    methods: ['C17.groupBy', 'C17.having'],
    async run(client, mode) {
      const query = base(client, mode)
      const all = await query.groupBy('active').aggregateGroups('count')
      assert.deepEqual(
        all.groups.map((group) => [group.keys.active, Number(group.value)]),
        [
          [false, 1],
          [true, 2],
        ],
      )
      const filtered = await query
        .groupBy('active')
        .having('$aggregate', '>', 1)
        .aggregateGroups('count')
      assert.deepEqual(
        filtered.groups.map((group) => [
          group.keys.active,
          Number(group.value),
        ]),
        [[true, 2]],
      )
    },
  },
  {
    name: 'portable C18 pages and scope-bound keyset cursor survive boundary progression',
    methods: [
      'C18.paginate',
      'C18.simplePaginate',
      'C18.cursorPaginate',
      'C18.cursorScope',
    ],
    async run(client, mode) {
      const query = base(client, mode)
      const page = await query.paginate(2)
      assert.deepEqual(identities(page.data), ['1', '2'])
      assert.equal(page.total, 3)
      assert.equal(page.hasMore, true)
      assert.deepEqual(identities((await query.simplePaginate(2, 2)).data), [
        '3',
      ])
      const first = await query.cursorPaginate(2)
      assert.deepEqual(identities(first.data), ['1', '2'])
      assert.ok(first.nextCursor)
      assert.deepEqual(
        identities((await query.cursorPaginate(2, first.nextCursor!)).data),
        ['3'],
      )
      await assert.rejects(
        query.orderByDesc('id').cursorPaginate(2, first.nextCursor!),
        (error) =>
          error instanceof SynloquentError && error.code === 'cursor_expired',
      )
    },
  },
  {
    name: 'portable C19 all async iteration methods traverse bounded pages',
    methods: [
      'C19.chunk',
      'C19.chunkById',
      'C19.lazy',
      'C19.lazyById',
      'C19.cursor',
      'C19.iterationIsolation',
    ],
    async run(client, mode) {
      const query = base(client, mode)
      const pages: string[][] = []
      await query.chunk(2, async (rows) => {
        pages.push(identities(rows))
      })
      assert.deepEqual(pages, [['1', '2'], ['3']])
      const keyset: string[][] = []
      await query.chunkById(2, async (rows) => {
        keyset.push(identities(rows))
      })
      assert.deepEqual(keyset, pages)
      for (const source of [query.lazy(2), query.lazyById(2), query.cursor()]) {
        const ids: string[] = []
        for await (const model of source) ids.push(String(model.id))
        assert.deepEqual(ids, ['1', '2', '3'])
      }
      let calls = 0
      await query.chunk(1, async () => {
        calls++
        return false
      })
      assert.equal(calls, 1)
    },
  },
  {
    name: 'portable C20 conditional immutable branches retain the original builder',
    methods: ['C20.when', 'C20.unless', 'C20.immutableBranches'],
    async run(client, mode) {
      const query = base(client, mode)
      assert.deepEqual(
        identities(
          await query.when(true, (branch) => branch.where('id', 1)).get(),
        ),
        ['1'],
      )
      assert.deepEqual(
        identities(
          await query.unless(false, (branch) => branch.where('id', 2)).get(),
        ),
        ['2'],
      )
      assert.deepEqual(identities(await query.get()), ['1', '2', '3'])
      assert.deepEqual(
        identities(
          await query
            .when(
              false,
              (branch) => branch.where('id', 1),
              (branch) => branch.where('id', 3),
            )
            .get(),
        ),
        ['3'],
      )
    },
  },
  {
    name: 'portable C21 explicit authorized joins preserve base projection',
    methods: ['C21.join', 'C21.leftJoin', 'C21.joinedAuthorization'],
    async run(client, mode) {
      const query = base(client, mode)
      assert.deepEqual(
        identities(
          await query.join('Category', 'category', 'category_id', 'id').get(),
        ),
        ['1', '2', '3'],
      )
      assert.deepEqual(
        identities(
          await query
            .leftJoin('Category', 'category', 'category_id', 'id')
            .whereJoined('category', 'id', '=', 1)
            .get(),
        ),
        ['1', '2', '3'],
      )
      await assert.rejects(
        query.join('UnexportedSecret', 'secret', 'id', 'id').get(),
        (error) => error instanceof SynloquentError || error instanceof Error,
      )
    },
  },
  {
    name: 'portable C22 scalar and correlated subqueries plus ordered union variants',
    methods: [
      'C22.selectSub',
      'C22.whereSub',
      'C22.whereExists',
      'C22.whereNotExists',
      'C22.union',
      'C22.unionAll',
    ],
    async run(client, mode) {
      const query = base(client, mode)
      const image = base(client, mode, 'Image')
      const correlated = [{ innerField: 'item_id', outerField: 'id' }]
      assert.equal(
        Number(
          (
            await query
              .selectSub(image.select('id').limit(1), 'image_id', correlated)
              .findOrFail(1)
          ).projections.image_id,
        ),
        1,
      )
      assert.deepEqual(
        identities(
          await query
            .whereSub('quantity', '=', image.select('id').limit(1), correlated)
            .get(),
        ),
        ['1', '2', '3'],
      )
      assert.deepEqual(
        identities(await query.whereExists(image, correlated).get()),
        ['1', '2', '3'],
      )
      assert.deepEqual(
        identities(await query.whereNotExists(image, correlated).get()),
        [],
      )
      assert.deepEqual(
        identities(
          await query.where('id', 1).union(query.where('id', 3)).get(),
        ),
        ['1', '3'],
      )
      assert.deepEqual(
        identities(
          await query.where('id', 1).unionAll(query.where('id', 1)).get(),
        ),
        ['1', '1'],
      )
    },
  },
  {
    name: 'portable C35 eager nesting constraints and relation field projection',
    methods: [
      'C35.with',
      'C35.nestedWith',
      'C35.constrainedWith',
      'C35.eagerFieldSelection',
    ],
    async run(client, mode) {
      const query = base(client, mode)
      const eager = await query.with('category', 'images').findOrFail(1)
      assert.equal(eager.relation('category').current?.length, 1)
      assert.equal(eager.relation('images').current?.length, 1)
      const nested = await query.with('category.items').findOrFail(1)
      assert.equal(
        nested.relation('category').current?.first()?.relation('items').current
          ?.length,
        3,
      )
      const constrained = await query
        .withConstrained('images', (related) =>
          related.where('id', '>', 1).select('url'),
        )
        .findOrFail(1)
      assert.equal(constrained.relation('images').current?.length, 0)
      const selected = await query
        .withConstrained('images', (related) => related.select('url'))
        .findOrFail(1)
      assert.deepEqual(
        Object.keys(
          selected.relation('images').current?.first()?.toJSON() ?? {},
        ).sort(),
        ['id', 'url'],
      )
    },
  },
  {
    name: 'portable C37 relation counts predicates and every OR variant',
    methods: [
      'C37.has',
      'C37.doesntHave',
      'C37.whereHas',
      'C37.whereDoesntHave',
      'C37.orHas',
      'C37.orDoesntHave',
      'C37.orWhereHas',
      'C37.orWhereDoesntHave',
    ],
    async run(client, mode) {
      const query = base(client, mode)
      assert.deepEqual(identities(await query.has('tags').get()), ['1'])
      assert.deepEqual(identities(await query.doesntHave('tags').get()), [
        '2',
        '3',
      ])
      assert.deepEqual(
        identities(
          await query
            .whereHas('images', (related) => related.where('id', 2))
            .get(),
        ),
        ['2'],
      )
      assert.deepEqual(
        identities(
          await query
            .whereDoesntHave('images', (related) => related.where('id', 2))
            .get(),
        ),
        ['1', '3'],
      )
      assert.deepEqual(
        identities(await query.where('id', 3).orHas('tags').get()),
        ['1', '3'],
      )
      assert.deepEqual(
        identities(await query.where('id', 1).orDoesntHave('tags').get()),
        ['1', '2', '3'],
      )
      assert.deepEqual(
        identities(
          await query
            .where('id', 1)
            .orWhereHas('images', (related) => related.where('id', 2))
            .get(),
        ),
        ['1', '2'],
      )
      assert.deepEqual(
        identities(
          await query
            .where('id', 2)
            .orWhereDoesntHave('tags', (related) => related.where('id', 1))
            .get(),
        ),
        ['2', '3'],
      )
    },
  },
  {
    name: 'portable C38 related field and explicit belongs-to filters',
    methods: ['C38.whereRelation', 'C38.whereBelongsTo'],
    async run(client, mode) {
      const query = base(client, mode)
      assert.deepEqual(
        identities(await query.whereRelation('images', 'id', '=', 2).get()),
        ['2'],
      )
      const category = await base(client, mode, 'Category').findOrFail(1)
      assert.deepEqual(
        identities(await query.whereBelongsTo(category, 'category').get()),
        ['1', '2', '3'],
      )
    },
  },
  {
    name: 'portable C38 morph relation predicates retain explicit target identity and type',
    methods: ['C38.whereMorphRelation'],
    async run(client, mode) {
      const notes = base(client, mode, 'Note')
      assert.deepEqual(
        identities(
          await notes
            .whereMorphRelation(
              'notable',
              ['Item'],
              'title',
              '=',
              'Alpine stamp',
            )
            .get(),
        ),
        ['1'],
      )
      assert.deepEqual(
        identities(
          await notes
            .whereMorphRelation(
              'notable',
              ['Category'],
              'title',
              '=',
              'Mountains',
            )
            .get(),
        ),
        ['2'],
      )
      assert.deepEqual(
        identities(
          await notes
            .whereMorphRelation('notable', ['Item'], 'title', '=', 'Mountains')
            .get(),
        ),
        [],
      )
      assert.throws(
        () =>
          notes.whereMorphRelation(
            'notable',
            ['UnexportedSecret'],
            'title',
            '=',
            'Secret',
          ),
        (error) =>
          error instanceof SynloquentError && error.code === 'unknown_relation',
      )
    },
  },
  {
    name: 'portable C39 batched readonly relation aggregate metadata',
    methods: [
      'C39.withCount',
      'C39.withExists',
      'C39.withSum',
      'C39.withMin',
      'C39.withMax',
      'C39.withAvg',
    ],
    async run(client, mode) {
      const query = base(client, mode, 'Category')
      const category = await query
        .withCount('items')
        .withExists('items')
        .withSum('items', 'quantity')
        .withMin('items', 'quantity')
        .withMax('items', 'quantity')
        .withAvg('items', 'quantity')
        .firstOrFail()
      assert.equal(Number(category.aggregates.items_count), 3)
      assert.equal(category.aggregates.items_exists, true)
      assert.equal(Number(category.aggregates.items_sum_quantity), 6)
      assert.equal(Number(category.aggregates.items_min_quantity), 1)
      assert.equal(Number(category.aggregates.items_max_quantity), 3)
      assert.equal(Number(category.aggregates.items_avg_quantity), 2)
      assert.equal(category.toJSON().items_count, undefined)
    },
  },
  {
    name: 'portable C28 C29 C30 C31 C32 C33 reflected relation families and both pivot directions',
    methods: [
      'C28.belongsTo',
      'C29.hasOne',
      'C29.hasMany',
      'C30.belongsToMany',
      'C30.customPivotTable',
      'C30.customPivotKeys',
      'C30.compositePivotIdentity',
      'C31.hasOneThrough',
      'C31.hasManyThrough',
      'C32.morphTo',
      'C32.morphOne',
      'C32.morphMany',
      'C32.explicitMorphMap',
      'C33.morphToMany',
      'C33.morphedByMany',
    ],
    async run(client, mode) {
      const item = await base(client, mode)
        .with(
          'category',
          'images',
          'latestImage',
          'firstNote',
          'notes',
          'tags',
          'classifications',
          'salespoints',
        )
        .findOrFail(1)
      assert.equal(
        item.relation('category').current?.first()?.attributes.title,
        'Mountains',
      )
      assert.deepEqual(identities(item.relation('images').current!), ['1'])
      assert.deepEqual(identities(item.relation('latestImage').current!), ['1'])
      assert.equal(
        item.relation('firstNote').current?.first()?.attributes.body,
        'Synthetic item note',
      )
      assert.equal(
        item.relation('notes').current?.first()?.attributes.body,
        'Synthetic item note',
      )
      assert.deepEqual(identities(item.relation('tags').current!), ['1'])
      assert.deepEqual(identities(item.relation('classifications').current!), [
        '1',
      ])
      assert.equal(
        item.relation('salespoints').current?.first()?.attributes.title,
        'Synthetic shop',
      )
      const category = await base(client, mode, 'Category')
        .with('imagesThrough', 'firstImageThrough', 'notes')
        .findOrFail(1)
      assert.deepEqual(
        identities(category.relation('imagesThrough').current!),
        ['1', '2', '3'],
      )
      assert.deepEqual(
        identities(category.relation('firstImageThrough').current!),
        ['1'],
      )
      assert.equal(
        category.relation('notes').current?.first()?.attributes.body,
        'Synthetic category note',
      )
      const notes = await base(client, mode, 'Note').with('notable').get()
      assert.deepEqual(
        notes.items.map(
          (note) => note.relation('notable').current?.first()?.modelName,
        ),
        ['Item', 'Category'],
      )
      const tag = await base(client, mode, 'Tag')
        .with('items', 'classifiedItems')
        .findOrFail(1)
      assert.deepEqual(identities(tag.relation('items').current!), ['1'])
      assert.deepEqual(identities(tag.relation('classifiedItems').current!), [
        '1',
      ])
      assert.notEqual(
        client.storage.manifest.models.Item!.relations.tags!.pivot!.foreignKey,
        client.storage.manifest.models.Item!.relations.tags!.pivot!.relatedKey,
      )
    },
  },
  {
    name: 'portable C36 explicit lazy loading has no property IO and loads only missing caches',
    methods: [
      'C36.load',
      'C36.loadMissing',
      'C36.batchedLazyLoading',
      'C36.noHiddenPropertyIO',
    ],
    async run(client, mode) {
      const item = await base(client, mode).findOrFail(1)
      assert.equal(item.relation('images').current, undefined)
      assert.equal(item.relation('category').current, undefined)
      await item.load('images', 'category')
      assert.deepEqual(identities(item.relation('images').current!), ['1'])
      assert.equal(item.relation('category').current?.length, 1)
      const current = item.relation('images').current
      await item.loadMissing('images')
      assert.equal(item.relation('images').current, current)
    },
  },
  {
    name: 'portable C39 explicit loaded aggregates retain read-only result metadata',
    methods: [
      'C39.loadCount',
      'C39.loadExists',
      'C39.loadSum',
      'C39.loadMin',
      'C39.loadMax',
      'C39.loadAvg',
    ],
    async run(client, mode) {
      const category = await base(client, mode, 'Category').findOrFail(1)
      assert.deepEqual(await category.loadCount('items'), { items: 3 })
      assert.equal((await category.loadExists('items')).items_exists, true)
      assert.equal(
        (await category.loadSum('items', 'quantity')).items_sum_quantity,
        6,
      )
      assert.equal(
        (await category.loadMin('items', 'quantity')).items_min_quantity,
        1,
      )
      assert.equal(
        (await category.loadMax('items', 'quantity')).items_max_quantity,
        3,
      )
      assert.equal(
        (await category.loadAvg('items', 'quantity')).items_avg_quantity,
        2,
      )
      assert.equal(category.toJSON().items_count, undefined)
    },
  },
  {
    name: 'portable C40 pivot projection casts filters and ordering use exported attributes',
    methods: [
      'C40.pivotAttributes',
      'C40.withPivot',
      'C40.pivotCast',
      'C40.wherePivot',
      'C40.orderByPivot',
    ],
    async run(client, mode) {
      const item = await base(client, mode).findOrFail(1)
      const tags = await item
        .relation('tags')
        .withPivot('position')
        .wherePivot('position', 1)
        .orderByPivot('position')
        .get()
      assert.deepEqual(identities(tags), ['1'])
      assert.equal(
        (tags.first() as ModelInstance & { pivot: { position: number } }).pivot
          .position,
        1,
      )
      assert.equal(
        (await item.relation('tags').wherePivot('position', 999).get()).length,
        0,
      )
    },
  },
]

async function acknowledge(
  client: Pick<SynloquentClient, 'sync'>,
  model: ModelInstance,
): Promise<ModelInstance> {
  if (model.lastOperationId) await client.sync.confirmed(model.lastOperationId)
  await model.refresh()
  return model
}
function uniqueTitle(
  client: Pick<SynloquentClient, 'storage'>,
  mode: string,
  purpose: string,
): string {
  return `Portable ${mode} ${purpose} ${client.storage.configuration.generateIdentity()}`
}
export const portableMutationScenarios: readonly PortableScenario[] = [
  {
    name: 'portable C03 C04 C05 C06 C07 C08 C25 durable drafts and actual canonical writes',
    methods: [
      'C03.create',
      'C03.fill',
      'C03.forceFill',
      'C03.save',
      'C03.update',
      'C03.delete',
      'C04.fresh',
      'C04.refresh',
      'C04.getOriginal',
      'C04.getChanges',
      'C04.isDirty',
      'C04.isClean',
      'C04.wasChanged',
      'C04.canonicalProposalDistinction',
      'C05.replicate',
      'C05.defaults',
      'C05.timestamps',
      'C05.touch',
      'C06.booleanCast',
      'C06.integerCast',
      'C06.stringCast',
      'C06.floatPrecision',
      'C06.decimalCast',
      'C06.dateCast',
      'C06.datetimeCast',
      'C06.jsonCast',
      'C06.enumCast',
      'C07.customCast',
      'C07.accessor',
      'C07.materializedAppend',
      'C07.offlineAvailability',
      'C08.hiddenSerialization',
      'C08.visibleSerialization',
      'C08.readableProjection',
      'C08.writableProjection',
      'C25.increment',
      'C25.decrement',
    ],
    async run(client, mode) {
      const query = base(client, mode)
      const title = uniqueTitle(client, mode, 'draft')
      const draft = await query.firstOrNew({ title })
      assert.equal(draft.exists, false)
      assert.equal(draft.isDirty('title'), true)
      assert.equal(draft.attributes.active, true)
      assert.equal(draft.attributes.price, '0.00')
      assert.equal(draft.attributes.quantity, 0)
      assert.equal(draft.attributes.display_label, undefined)
      draft.fill({
        quantity: 4,
        active: false,
        price: '12.34',
        latitude: 49.123456,
        published_on: '2026-10-02',
        released_at: '2026-10-02T09:10:11.000000Z',
        metadata: { region: 'portable', list: [1, true, null] },
        labels: [null],
        status: 'published',
        catalog_code: '  xy-12 ',
      })
      draft.forceFill({ quantity: 5 })
      assert.throws(
        () => draft.forceFill({ display_label: 'Untrusted append' }),
        (error) =>
          error instanceof SynloquentError && error.code === 'forbidden_field',
      )
      assert.throws(
        () => draft.fill({ tenant_id: 999 }),
        (error) =>
          error instanceof SynloquentError && error.code === 'unknown_field',
      )
      assert.equal(draft.getOriginal('title'), undefined)
      await draft.save()
      assert.equal(draft.isClean(), true)
      assert.equal(draft.wasChanged('quantity'), true)
      assert.equal(draft.getChanges().quantity, 5)
      assert.equal(draft.canonicalRecord(), null)
      const identity = draft.localIdentity
      await acknowledge(client, draft)
      assert.equal(draft.localIdentity, identity)
      assert.equal(draft.syncState, 'synced')
      assert.equal(draft.attributes.catalog_code, 'XY-12')
      assert.equal(draft.attributes.display_label, `${title} / published`)
      assert.equal(draft.attributes.active, false)
      assert.equal(draft.attributes.quantity, 5)
      assert.equal(draft.attributes.latitude, 49.123456)
      assert.equal(draft.attributes.price, '12.34')
      assert.equal(draft.attributes.published_on, '2026-10-02')
      assert.match(String(draft.attributes.released_at), /^2026-10-02T09:10:11/)
      assert.deepEqual(draft.attributes.metadata, {
        region: 'portable',
        list: [1, true, null],
      })
      assert.equal(draft.attributes.status, 'published')
      assert.equal(draft.toJSON().tenant_id, undefined)
      assert.equal(draft.toJSON().display_label, `${title} / published`)
      assert.match(String(draft.attributes.created_at), /^\d{4}-\d{2}-\d{2}T/)
      assert.match(String(draft.attributes.updated_at), /^\d{4}-\d{2}-\d{2}T/)
      const original = draft.getOriginal('quantity')
      draft.fill({ quantity: 6 })
      assert.equal(draft.getOriginal('quantity'), original)
      assert.equal(draft.isDirty('quantity'), true)
      assert.equal(draft.canonicalRecord()?.attributes.quantity, 5)
      await draft.save()
      assert.equal(draft.getChanges().quantity, 6)
      await acknowledge(client, draft)
      await draft.update({ quantity: 7 })
      await acknowledge(client, draft)
      await draft.increment('quantity', 3)
      await acknowledge(client, draft)
      assert.equal(draft.attributes.quantity, 10)
      await draft.decrement('quantity', 2)
      await acknowledge(client, draft)
      assert.equal(draft.attributes.quantity, 8)
      assert.equal((await draft.fresh())?.attributes.quantity, 8)
      draft.fill({ quantity: 999 })
      await draft.refresh()
      assert.equal(draft.attributes.quantity, 8)
      await draft.touch()
      await acknowledge(client, draft)
      const copy = draft.replicate(['catalog_code'])
      assert.equal(copy.exists, false)
      assert.notEqual(copy.localIdentity, draft.localIdentity)
      assert.equal(copy.attributes.created_at, undefined)
      assert.equal(copy.attributes.catalog_code, undefined)
      const created = await query.create({
        title: uniqueTitle(client, mode, 'create'),
      })
      await acknowledge(client, created)
      assert.equal(
        Object.hasOwn(
          (await query.select('title').findOrFail(String(created.id))).toJSON(),
          'price',
        ),
        false,
      )
      await created.delete()
      if (created.lastOperationId)
        await client.sync.confirmed(created.lastOperationId)
      assert.equal(await query.find(String(created.id)), null)
      await draft.delete()
      if (draft.lastOperationId)
        await client.sync.confirmed(draft.lastOperationId)
      assert.equal(await query.find(String(draft.id)), null)
    },
  },
  {
    name: 'portable C01 C05 assigned UUID ULID custom string keys and stable local aliases',
    methods: [
      'C01.integerKey',
      'C01.stringKey',
      'C01.customKey',
      'C01.uuid',
      'C01.ulid',
      'C01.localIdentity',
      'C05.nonIncrementingKey',
    ],
    async run(client, mode) {
      const integer = await base(client, mode).create({
        title: uniqueTitle(client, mode, 'integer'),
      })
      const local = integer.localIdentity
      await acknowledge(client, integer)
      assert.match(String(integer.id), /^\d+$/)
      assert.equal(integer.localIdentity, local)
      for (const [model, key, value] of [
        ['UuidRecord', 'id', '0148b9f2-6c8c-4ab1-9c6e-0ba57409d6e1'],
        ['UlidRecord', 'id', '01J9RJF3DSCZGCRTZCPSDMKHXN'],
        ['ExternalRecord', 'external_key', 'portable-external-é'],
      ] as const) {
        const identifier =
          mode === 'local'
            ? value
            : model === 'UuidRecord'
              ? '0148b9f2-6c8c-4ab1-9c6e-0ba57409d6e2'
              : model === 'UlidRecord'
                ? '01J9RJF3DSCZGCRTZCPSDMKHXP'
                : 'portable-external-ž'
        const created = await base(client, mode, model).create({
          [key]: identifier,
          title: uniqueTitle(client, mode, model),
        })
        const identity = created.localIdentity
        await acknowledge(client, created)
        assert.equal(created.id, identifier)
        assert.equal(created.localIdentity, identity)
        assert.equal(
          (await base(client, mode, model).findOrFail(identifier)).attributes[
            key
          ],
          identifier,
        )
        await created.delete()
        if (created.lastOperationId)
          await client.sync.confirmed(created.lastOperationId)
      }
      await integer.delete()
      if (integer.lastOperationId)
        await client.sync.confirmed(integer.lastOperationId)
    },
  },
  {
    name: 'portable C23 C24 unique helpers and bounded atomic bulk event intent',
    methods: [
      'C23.firstOrCreate',
      'C23.firstOrNew',
      'C23.updateOrCreate',
      'C24.upsert',
      'C24.insert',
      'C24.bulkUpdate',
      'C24.bulkDelete',
      'C24.batchAtomicity',
      'C24.bulkEventDistinction',
    ],
    async run(client, mode) {
      const query = base(client, mode)
      const title = uniqueTitle(client, mode, 'unique')
      const first = await query.firstOrCreate({ title }, { quantity: 2 })
      await acknowledge(client, first)
      const again = await query.firstOrCreate({ title }, { quantity: 999 })
      assert.equal(String(again.id), String(first.id))
      assert.equal(again.attributes.quantity, 2)
      const updated = await query.updateOrCreate({ title }, { quantity: 3 })
      await acknowledge(client, updated)
      assert.equal(updated.attributes.quantity, 3)
      const draft = await query.firstOrNew({
        title: uniqueTitle(client, mode, 'unpersisted'),
      })
      assert.equal(draft.exists, false)
      assert.equal(await base(client, 'local').find(draft.localIdentity), null)
      const secondTitle = uniqueTitle(client, mode, 'bulk')
      const inserted = await query.insert([{ title: secondTitle, quantity: 4 }])
      await client.sync.flush()
      const insertedModel = await base(client, 'local').findOrFail(
        inserted.first()!.localIdentity,
      )
      assert.equal(insertedModel.attributes.quantity, 4)
      const upserted = await query
        .whereIn('title', [title, secondTitle])
        .upsert(
          [
            { title, quantity: 6 },
            { title: secondTitle, quantity: 7 },
          ],
          ['title'],
          ['quantity'],
        )
      await client.sync.flush()
      assert.equal(upserted.length, 2)
      assert.deepEqual(
        (
          await query
            .whereIn('title', [title, secondTitle])
            .orderBy('quantity')
            .pluck('quantity')
        ).all(),
        [6, 7],
      )
      assert.equal(
        await query
          .whereIn('title', [title, secondTitle])
          .update({ quantity: 8 }),
        2,
      )
      await client.sync.flush()
      assert.deepEqual(
        (
          await query.whereIn('title', [title, secondTitle]).pluck('quantity')
        ).all(),
        [8, 8],
      )
      const entries = await client.storage.read((executor) =>
        client.storage.pending(executor),
      )
      const bulk = entries.filter(
        (entry) =>
          [first.localIdentity, insertedModel.localIdentity].includes(
            entry.operation.localIdentity,
          ) &&
          entry.operation.atomicGroup &&
          entry.operation.action === 'update' &&
          entry.operation.values.quantity === 8,
      )
      assert.equal(bulk.length, 2)
      assert.equal(
        bulk[0]!.operation.atomicGroup,
        bulk[1]!.operation.atomicGroup,
      )
      assert.equal(
        bulk.every((entry) => entry.operation.eventMode === 'bulk'),
        true,
      )
      const before = (
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        )
      ).length
      const duplicate = uniqueTitle(client, mode, 'duplicate')
      await assert.rejects(
        query.insert([{ title: duplicate }, { title: duplicate }]),
        /UNIQUE/,
      )
      assert.equal(
        (
          await client.storage.read((executor) =>
            client.storage.pending(executor),
          )
        ).length,
        before,
      )
      assert.equal(
        await base(client, 'local').where('title', duplicate).first(),
        null,
      )
      assert.equal(
        await query.whereIn('title', [title, secondTitle]).delete(),
        2,
      )
      await client.sync.flush()
      assert.equal(
        await query.whereIn('title', [title, secondTitle]).first(),
        null,
      )
    },
  },
  {
    name: 'portable C12 positive UTF8 equality and binary ordering of acknowledged rows',
    methods: ['C12.unicodeComparison'],
    async run(client, mode) {
      const prefix = uniqueTitle(client, mode, 'Unicode')
      const query = base(client, mode, 'Category')
      const records: ModelInstance[] = []
      for (const suffix of ['ž', 'é', 'É']) {
        const record = await query.create({ title: `${prefix} ${suffix}` })
        await acknowledge(client, record)
        records.push(record)
      }
      assert.equal(
        (await query.where('title', `${prefix} é`).firstOrFail()).attributes
          .title,
        `${prefix} é`,
      )
      assert.equal(await query.where('title', `${prefix} E`).first(), null)
      assert.deepEqual(
        (
          await query
            .where('title', 'like', `${prefix}%`)
            .orderBy('title')
            .pluck('title')
        ).all(),
        [`${prefix} É`, `${prefix} é`, `${prefix} ž`],
      )
      for (const [suffix, pattern] of [
        ['100%', String.raw`100\%`],
        ['one_two', String.raw`one\_two`],
        [String.raw`back\slash`, String.raw`back\\slash`],
        ['glob*?[]', 'glob*?[]'],
        ['letteré', 'letter_'],
        ['emoji😀', 'emoji_'],
      ] as const) {
        const record = await query.create({ title: `${prefix} ${suffix}` })
        await acknowledge(client, record)
        records.push(record)
        assert.deepEqual(
          (
            await query
              .where('title', 'like', `${prefix} ${pattern}`)
              .pluck('title')
          ).all(),
          [`${prefix} ${suffix}`],
        )
      }
      for (const record of records) {
        await record.delete()
        if (record.lastOperationId)
          await client.sync.confirmed(record.lastOperationId)
      }
    },
  },
  {
    name: 'portable C28 C41 C43 C44 association relation writes pivot operations and soft lifecycle',
    methods: [
      'C28.associate',
      'C28.dissociate',
      'C41.attach',
      'C41.detach',
      'C41.toggle',
      'C41.updateExistingPivot',
      'C41.relationRevision',
      'C43.relationCreate',
      'C43.relationCreateMany',
      'C43.relationSave',
      'C43.relationSaveMany',
      'C43.relatedDelete',
      'C44.softDelete',
      'C44.withTrashed',
      'C44.onlyTrashed',
      'C44.restore',
      'C44.forceDeleteAuthorization',
    ],
    async run(client, mode) {
      const parent = await base(client, mode).create({
        title: uniqueTitle(client, mode, 'relations'),
      })
      const category = await base(client, mode, 'Category').create({
        title: uniqueTitle(client, mode, 'associated'),
      })
      const tag = await base(client, mode, 'Tag').create({
        title: uniqueTitle(client, mode, 'pivot'),
      })
      await acknowledge(client, parent)
      await acknowledge(client, category)
      await acknowledge(client, tag)
      await parent.relation('category').associate(category)
      await parent.save()
      await acknowledge(client, parent)
      assert.equal(
        (
          await base(client, mode)
            .with('category')
            .findOrFail(String(parent.id))
        )
          .relation('category')
          .current?.first()?.attributes.title,
        category.attributes.title,
      )
      await parent.relation('category').dissociate()
      await parent.save()
      await acknowledge(client, parent)
      assert.equal(parent.attributes.category_id, null)
      const image = await parent
        .relation('images')
        .create({ url: 'portable-create.jpg' })
      await acknowledge(client, image)
      assert.equal(String(image.attributes.item_id), String(parent.id))
      const many = await parent
        .relation('images')
        .createMany([
          { url: 'portable-many-1.jpg' },
          { url: 'portable-many-2.jpg' },
        ])
      await client.sync.flush()
      assert.equal(many.length, 2)
      const draft = await base(client, 'local', 'Image').firstOrNew({
        url: 'portable-save.jpg',
        item_id: parent.id,
      })
      const saved = await parent.relation('images').save(draft)
      await acknowledge(client, saved)
      assert.equal(saved.localIdentity, draft.localIdentity)
      const drafts = await Promise.all(
        ['portable-save-many-1.jpg', 'portable-save-many-2.jpg'].map((url) =>
          base(client, 'local', 'Image').firstOrNew({
            url,
            item_id: parent.id,
          }),
        ),
      )
      const savedMany = await parent.relation('images').saveMany(drafts)
      await client.sync.flush()
      assert.deepEqual(
        savedMany.items.map((model) => model.localIdentity),
        drafts.map((model) => model.localIdentity),
      )
      assert.equal(
        (
          await base(client, mode).with('images').findOrFail(String(parent.id))
        ).relation('images').current?.length,
        6,
      )
      await parent.relation('tags').attach([tag], { position: 2 })
      await client.sync.flush()
      assert.equal(
        (
          await base(client, mode).with('tags').findOrFail(String(parent.id))
        ).relation('tags').current?.length,
        1,
      )
      const membership = await client.storage.read((executor) =>
        executor.execute(
          'SELECT revision FROM syn_relation_sets WHERE partition=? AND model=? AND relation=? AND parent_identity=?',
          [client.storage.partition, 'Item', 'tags', parent.localIdentity],
        ),
      )
      assert.ok(membership.rows[0]?.revision)
      await parent.relation('tags').updateExistingPivot(tag, { position: 3 })
      await client.sync.flush()
      assert.equal(
        (
          (await base(client, mode).with('tags').findOrFail(String(parent.id)))
            .relation('tags')
            .current?.first() as ModelInstance & { pivot: { position: number } }
        ).pivot.position,
        3,
      )
      await parent.relation('tags').toggle([tag])
      await client.sync.flush()
      assert.equal(
        (
          await base(client, mode).with('tags').findOrFail(String(parent.id))
        ).relation('tags').current?.length,
        0,
      )
      await parent.relation('tags').toggle([tag], { position: 1 })
      await client.sync.flush()
      await parent.relation('tags').detach([tag])
      await client.sync.flush()
      assert.equal(
        (
          await base(client, mode).with('tags').findOrFail(String(parent.id))
        ).relation('tags').current?.length,
        0,
      )
      const note = await parent
        .relation('notes')
        .create({ body: 'Portable soft lifecycle' })
      await acknowledge(client, note)
      const noteId = String(note.id)
      await note.delete()
      if (note.lastOperationId)
        await client.sync.confirmed(note.lastOperationId)
      assert.equal(await base(client, mode, 'Note').find(noteId), null)
      assert.equal(
        (await base(client, mode, 'Note').withTrashed().findOrFail(noteId))
          .attributes.body,
        'Portable soft lifecycle',
      )
      assert.equal(
        (await base(client, mode, 'Note').onlyTrashed().findOrFail(noteId))
          .attributes.body,
        'Portable soft lifecycle',
      )
      await note.restore()
      await acknowledge(client, note)
      assert.equal(
        (await base(client, mode, 'Note').findOrFail(noteId)).attributes
          .deleted_at,
        null,
      )
      await note.forceDelete()
      if (note.lastOperationId)
        await client.sync.confirmed(note.lastOperationId)
      assert.equal(
        await base(client, mode, 'Note').withTrashed().find(noteId),
        null,
      )
      assert.equal(await parent.relation('images').delete(), 6)
      await client.sync.flush()
      assert.equal(
        (
          await base(client, mode).with('images').findOrFail(String(parent.id))
        ).relation('images').current?.length,
        0,
      )
      const cleanup = [parent, category, tag].map((record) => ({
        model: record.modelName,
        identity: record.localIdentity,
      }))
      const scope = JSON.parse(
        (await client.storage.metadata('scope')) ?? '{}',
      ) as { dataset?: string }
      await client.sync.pull(scope.dataset ?? 'default')
      for (const target of cleanup) {
        const record = await client
          .query(target.model)
          .findOrFail(target.identity)
        await record.delete()
        if (record.lastOperationId)
          await client.sync.confirmed(record.lastOperationId)
      }
    },
  },
]
