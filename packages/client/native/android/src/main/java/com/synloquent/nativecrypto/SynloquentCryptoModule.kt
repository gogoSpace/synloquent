package com.synloquent.nativecrypto

import android.app.ActivityManager
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.os.Debug
import android.os.SystemClock
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

class SynloquentCryptoModule(context: ReactApplicationContext) : NativeSynloquentCryptoSpec(context) {
  private data class HashContext(
    val digest: MessageDigest,
    var bytes: Long = 0,
    var cpuNanoseconds: Long = 0,
    var wallNanoseconds: Long = 0,
  )

  private val invalidated = AtomicBoolean(false)
  private val memoryObservationLock = Any()
  private var memoryObservationStarted = false
  private val memoryCallbacks = object : ComponentCallbacks2 {
    override fun onConfigurationChanged(newConfiguration: Configuration) = Unit

    override fun onTrimMemory(level: Int) {
      val kind = when {
        level >= ComponentCallbacks2.TRIM_MEMORY_COMPLETE -> "critical"
        level >= ComponentCallbacks2.TRIM_MEMORY_MODERATE -> "warning"
        level >= ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN -> "background"
        level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL -> "critical"
        level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE -> "warning"
        else -> return
      }
      reportMemoryPressure(kind, "onTrimMemory", level)
    }

    @Deprecated("Legacy callback is not delivered on Android 14 and later.")
    override fun onLowMemory() = reportMemoryPressure("critical", "onLowMemory", null)
  }
  private val contexts = mutableMapOf<String, HashContext>()
  private val worker = Executors.newSingleThreadExecutor { operation ->
    Thread(operation, "synloquent-sha256-worker")
  }

  override fun getName() = NAME

  private fun perform(promise: Promise, operation: () -> Any?) {
    try {
      worker.execute {
        try {
          promise.resolve(operation())
        } catch (failure: Exception) {
          promise.reject("hash_failed", failure.message, failure)
        }
      }
    } catch (failure: RejectedExecutionException) {
      promise.reject("hash_closed", "The native hash worker is closed.", failure)
    }
  }

  override fun threadCpuMilliseconds(): Double = Debug.threadCpuTimeNanos().toDouble() / 1000000

  private fun reportMemoryPressure(kind: String, source: String, trimMemoryLevel: Int?) {
    synchronized(memoryObservationLock) {
      if (invalidated.get() || !memoryObservationStarted || mEventEmitterCallback == null) return
      emitOnMemoryPressure(Arguments.createMap().apply {
        putString("kind", kind)
        putString("source", source)
        if (trimMemoryLevel != null) putDouble("trimMemoryLevel", trimMemoryLevel.toDouble())
        putDouble("observedAtMonotonicMilliseconds", SystemClock.elapsedRealtimeNanos().toDouble() / 1000000)
      })
    }
  }

  override fun sampleMemory(promise: Promise) {
    try {
      synchronized(memoryObservationLock) {
        check(!invalidated.get()) { "Native memory observations are closed." }
        check(mEventEmitterCallback != null) { "Native memory events are not initialized." }
        if (!memoryObservationStarted) {
          reactApplicationContext.applicationContext.registerComponentCallbacks(memoryCallbacks)
          memoryObservationStarted = true
        }
      }
      val activityManager = requireNotNull(reactApplicationContext.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager) { "System memory observations are unavailable." }
      val memoryInfo = ActivityManager.MemoryInfo()
      activityManager.getMemoryInfo(memoryInfo)
      val sampledAt = SystemClock.elapsedRealtimeNanos().toDouble() / 1000000
      val sample = Arguments.createMap().apply {
        putNull("processHeadroomBytes")
        if (memoryInfo.availMem >= 0) putDouble("systemAvailableBytes", memoryInfo.availMem.toDouble()) else putNull("systemAvailableBytes")
        if (memoryInfo.threshold >= 0) putDouble("systemLowMemoryThresholdBytes", memoryInfo.threshold.toDouble()) else putNull("systemLowMemoryThresholdBytes")
        putBoolean("systemLowMemory", memoryInfo.lowMemory)
        putDouble("sampledAtMonotonicMilliseconds", sampledAt)
      }
      synchronized(memoryObservationLock) {
        check(!invalidated.get()) { "Native memory observations are closed." }
        promise.resolve(sample)
      }
    } catch (failure: Exception) {
      promise.reject("memory_unavailable", failure.message, failure)
    }
  }

  override fun start(promise: Promise) = perform(promise) {
    require(contexts.size < 8) { "Too many active hash contexts." }
    val identifier = UUID.randomUUID().toString()
    contexts[identifier] = HashContext(MessageDigest.getInstance("SHA-256"))
    identifier
  }

  override fun append(identifier: String, content: String, promise: Promise) = perform(promise) {
    val context = requireNotNull(contexts[identifier]) { "The hash context is closed or unknown." }
    require(content.length <= 65536) { "Hash chunks must contain at most 65536 UTF16 units." }
    val cpuStarted = Debug.threadCpuTimeNanos()
    val wallStarted = SystemClock.elapsedRealtimeNanos()
    val bytes = content.toByteArray(Charsets.UTF_8)
    require(bytes.size <= 262144 && context.bytes + bytes.size <= 268435456) { "Hash content exceeds its bounded input limit." }
    context.digest.update(bytes)
    context.bytes += bytes.size
    context.cpuNanoseconds += Debug.threadCpuTimeNanos() - cpuStarted
    context.wallNanoseconds += SystemClock.elapsedRealtimeNanos() - wallStarted
    null
  }

  override fun finish(identifier: String, promise: Promise) = perform(promise) {
    val context = requireNotNull(contexts[identifier]) { "The hash context is closed or unknown." }
    val cpuStarted = Debug.threadCpuTimeNanos()
    val wallStarted = SystemClock.elapsedRealtimeNanos()
    val hexadecimal = context.digest.digest().joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
    contexts.remove(identifier)
    Arguments.createMap().apply {
      putString("digest", hexadecimal)
      putDouble("bytes", context.bytes.toDouble())
      putDouble("cpuMilliseconds", (context.cpuNanoseconds + Debug.threadCpuTimeNanos() - cpuStarted).toDouble() / 1000000)
      putDouble("wallMilliseconds", (context.wallNanoseconds + SystemClock.elapsedRealtimeNanos() - wallStarted).toDouble() / 1000000)
    }
  }

  override fun cancel(identifier: String, promise: Promise) = perform(promise) {
    contexts.remove(identifier)
    null
  }

  override fun invalidate() {
    if (invalidated.compareAndSet(false, true)) {
      try {
        synchronized(memoryObservationLock) {
          if (memoryObservationStarted) {
            memoryObservationStarted = false
            reactApplicationContext.applicationContext.unregisterComponentCallbacks(memoryCallbacks)
          }
        }
      } finally {
        worker.execute { contexts.clear() }
        worker.shutdown()
      }
    }
    super.invalidate()
  }

  companion object {
    const val NAME = "NativeSynloquentCrypto"
  }
}
