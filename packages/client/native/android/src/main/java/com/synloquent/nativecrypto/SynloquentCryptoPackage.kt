package com.synloquent.nativecrypto

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class SynloquentCryptoPackage : BaseReactPackage() {
  override fun getModule(name: String, context: ReactApplicationContext): NativeModule? =
    if (name == SynloquentCryptoModule.NAME) SynloquentCryptoModule(context) else null

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    mapOf(
      SynloquentCryptoModule.NAME to ReactModuleInfo(
        SynloquentCryptoModule.NAME,
        SynloquentCryptoModule.NAME,
        false,
        false,
        false,
        true,
      ),
    )
  }
}
