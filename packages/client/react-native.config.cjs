module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: './native/android',
        packageImportPath:
          'import com.synloquent.nativecrypto.SynloquentCryptoPackage;',
        packageInstance: 'new SynloquentCryptoPackage()',
      },
      ios: { podspecPath: './SynloquentNativeCrypto.podspec' },
    },
  },
}
