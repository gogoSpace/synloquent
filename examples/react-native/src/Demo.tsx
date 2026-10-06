import 'react-native-get-random-values'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Button,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSynloquentQuery } from '@synloquent/client/react'
import {
  createReactNativeClient,
  type ReactNativeClientRuntime,
} from '@synloquent/client/react-native'
import type { SynloquentClient } from '@synloquent/client'
import {
  backendSchema,
  type BackendModels,
  type BackendCommands,
  type BackendScopes,
} from '../backend.generated'

type ExampleClient = SynloquentClient<
  BackendModels,
  BackendCommands,
  BackendScopes
>
type ExampleRuntime = ReactNativeClientRuntime<
  BackendModels,
  BackendCommands,
  BackendScopes
>

function generateIdentity(): string {
  const bytes = new Uint8Array(16)
  const nativeCrypto = (
    globalThis as typeof globalThis & {
      readonly crypto: { getRandomValues(buffer: Uint8Array): Uint8Array }
    }
  ).crypto
  nativeCrypto.getRandomValues(bytes)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hexadecimal = Array.from(bytes, (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('')
  return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`
}

const runtimeInstance = generateIdentity()
const session = {
  accountId: '1',
  tenantId: '1',
  deviceId: 'example-device',
  deviceEpoch: 'epoch-1',
  generation: 0,
} as const

function Catalog({
  client,
}: {
  readonly client: ExampleClient
}): React.JSX.Element {
  const query = useMemo(
    () =>
      client
        .query('Item')
        .where('title', 'like', 'Pre-alpha%')
        .orderBy('title')
        .take(50),
    [client],
  )
  const snapshot = useSynloquentQuery(client, query)
  const [status, setStatus] = useState('Ready offline')
  const [working, setWorking] = useState(false)
  const [outboxLoaded, setOutboxLoaded] = useState(false)
  const [pending, setPending] = useState<
    readonly {
      readonly action: string
      readonly operationId: string
      readonly localIdentity: string
      readonly id?: string
      readonly status: string
    }[]
  >([])
  const refreshPending = useCallback(async () => {
    const operations = await client.storage.read((executor) =>
      client.storage.pending(executor),
    )
    setPending(
      operations
        .filter((entry) => !['accepted', 'cancelled'].includes(entry.status))
        .map((entry) => ({
          action: entry.operation.action,
          operationId: entry.operation.operationId,
          localIdentity: entry.operation.localIdentity,
          ...(entry.operation.id ? { id: entry.operation.id } : {}),
          status: entry.status,
        })),
    )
    setOutboxLoaded(true)
  }, [client])
  useEffect(() => {
    void refreshPending().catch((failure) => setStatus(String(failure)))
  }, [refreshPending])
  const perform = async (description: string, action: () => Promise<void>) => {
    setWorking(true)
    setOutboxLoaded(false)
    setStatus(description)
    try {
      await action()
      await refreshPending()
      setStatus('Saved')
    } catch (failure) {
      setStatus(String(failure))
    } finally {
      setWorking(false)
    }
  }
  const rows = snapshot.data.items.map((item) => ({
    localIdentity: item.localIdentity,
    id: item.id,
    title: item.attributes.title,
    quantity: item.attributes.quantity,
    syncState: item.syncState,
  }))
  const state = JSON.stringify({
    runtimeInstance,
    loading: snapshot.loading || working || !outboxLoaded,
    rows,
    pending,
  })
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Synloquent pre-alpha</Text>
      <Text>Small offline catalog. Sync only when you choose.</Text>
      <Text
        testID="prealpha-status"
        accessibilityLabel={status}
        style={styles.status}
      >
        {status}
      </Text>
      <Button
        testID="prealpha-create"
        title="Create A and B offline"
        disabled={working || rows.length > 0}
        onPress={() =>
          void perform('Creating offline', async () => {
            await client.transaction(async (transaction) => {
              await transaction.models.Item.create({
                title: 'Pre-alpha A',
                price: '12.50',
                quantity: 1,
              })
              await transaction.models.Item.create({
                title: 'Pre-alpha B',
                price: '7.25',
                quantity: 1,
              })
            })
          })
        }
      />
      <Button
        testID="prealpha-update"
        title="Update A offline"
        disabled={working || rows.length === 0}
        onPress={() =>
          void perform('Updating offline', async () => {
            const item = await client.models.Item.where(
              'title',
              'like',
              'Pre-alpha A%',
            ).firstOrFail()
            item.fill({ title: 'Pre-alpha A updated', quantity: 2 })
            await item.save()
          })
        }
      />
      <Button
        testID="prealpha-sync"
        title="Sync with Laravel"
        disabled={working}
        onPress={() =>
          void perform('Synchronizing', async () => {
            await client.sync.flush()
            await client.sync.pull('catalog')
          })
        }
      />
      <Button
        testID="prealpha-delete"
        title="Delete B locally"
        disabled={working || !rows.some((row) => row.title === 'Pre-alpha B')}
        onPress={() =>
          void perform('Deleting offline', async () => {
            const item = await client.models.Item.where(
              'title',
              'Pre-alpha B',
            ).firstOrFail()
            await item.delete()
          })
        }
      />
      {working || snapshot.loading ? <ActivityIndicator /> : null}
      {snapshot.error ? (
        <Text style={styles.error}>{snapshot.error.message}</Text>
      ) : null}
      <Text>Pending changes: {pending.length}</Text>
      {rows.map((row) => (
        <Text key={row.localIdentity} style={styles.row}>
          {String(row.title)} · quantity {String(row.quantity)} ·{' '}
          {row.syncState}
        </Text>
      ))}
      <Text style={styles.details}>
        Local state for the reproducible walkthrough
      </Text>
      <Text
        testID="prealpha-state"
        numberOfLines={3}
        accessibilityLabel={state}
        style={styles.details}
      >
        {state}
      </Text>
    </View>
  )
}

export function Demo(): React.JSX.Element {
  const [client, setClient] = useState<ExampleClient>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let active = true
    let runtime: ExampleRuntime | undefined
    void createReactNativeClient<BackendModels, BackendCommands, BackendScopes>(
      {
        schema: backendSchema,
        database: { name: 'synloquent-example.sqlite' },
        session,
        generateIdentity,
        http: {
          endpoint: `${Platform.OS === 'android' ? 'http://10.0.2.2:8769' : 'http://127.0.0.1:8769'}/synloquent/v1/protocol`,
          authenticate: (identity) => ({
            session: identity.session,
            headers: {
              Authorization: `Bearer synthetic-actor-${identity.session.accountId}`,
            },
          }),
          timeoutMilliseconds: 10000,
        },
      },
    )
      .then(async (value) => {
        runtime = value
        if (active) setClient(value.client)
        else await value.close()
      })
      .catch((failure) => {
        if (active) setError(String(failure))
      })
    return () => {
      active = false
      void runtime?.close()
    }
  }, [])
  return client ? (
    <Catalog client={client} />
  ) : error ? (
    <Text style={styles.error}>{error}</Text>
  ) : (
    <ActivityIndicator />
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 18, gap: 8, backgroundColor: '#f6f8fb' },
  title: { fontSize: 24, fontWeight: '700', color: '#13304b' },
  status: { color: '#526477' },
  row: { paddingVertical: 8, fontSize: 16 },
  details: { fontSize: 10, color: '#526477' },
  error: { color: '#a21d27' },
})
