import React from 'react'
import {
  Platform,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  View,
} from 'react-native'
import { Demo } from './src/Demo'

const Screen = Platform.OS === 'android' ? View : SafeAreaView

export default function App(): React.JSX.Element {
  return (
    <Screen style={styles.container}>
      <StatusBar barStyle="dark-content" />
      <Demo />
    </Screen>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f6f8fb',
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0,
  },
})
