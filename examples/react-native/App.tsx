import React from 'react'
import { SafeAreaView, StyleSheet } from 'react-native'
import { Demo } from './src/Demo'

export default function App(): React.JSX.Element {
  return (
    <SafeAreaView style={styles.container}>
      <Demo />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({ container: { flex: 1 } })
