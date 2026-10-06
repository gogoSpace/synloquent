const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')
const path = require('node:path')

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const clientDirectory = path.resolve(__dirname, '../../packages/client')
const config = {
  watchFolders: [clientDirectory],
  resolver: {
    disableHierarchicalLookup: true,
    nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
  },
}

module.exports = mergeConfig(getDefaultConfig(__dirname), config)
