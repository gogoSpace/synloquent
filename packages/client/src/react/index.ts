import { useMemo, useSyncExternalStore } from 'react'
import type {
  Query,
  QuerySubscription,
  SynloquentClient,
  QuerySnapshot,
  ReadableFields,
  Attributes,
  QueryMode,
} from '../index.js'

export function useSynloquentQuery<
  Fields extends ReadableFields,
  WritableFields extends Attributes = Attributes,
  RelationNames extends string = string,
  Selection extends (keyof Fields & string) | undefined = undefined,
  Mode extends QueryMode = 'local',
>(
  client: Pick<SynloquentClient, 'storage' | 'observe'>,
  query: Query<Fields, WritableFields, RelationNames, Selection, Mode>,
): QuerySnapshot<Fields, WritableFields, RelationNames, Selection, Mode> {
  const key = query.observationKey
  const subscription: QuerySubscription<
    Fields,
    WritableFields,
    RelationNames,
    Selection,
    Mode
  > = useMemo(() => client.observe(query), [client, key])
  return useSyncExternalStore(
    subscription.subscribe,
    subscription.getSnapshot,
    subscription.getSnapshot,
  )
}
