package com.synloquent.example

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import org.json.JSONObject

/** Verification-only app receiver. It exposes two sizes inside this synthetic app container. */
class StorageMeasurementReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.getStringExtra("measurementMode") == "task-disk-v2") {
      receiveTaskDisk(context, intent)
      return
    }
    val path = intent.getStringExtra("path") ?: return
    val measurementId = intent.getStringExtra("measurementId") ?: return
    if (!measurementId.matches(Regex("storage-[a-f0-9]{32}-[1-9][0-9]{0,8}"))) return
    val pending = goAsync()
    try {
      worker.execute {
        var connection: HttpURLConnection? = null
        var responseCode: Int? = null
        var responseBody = ""
        try {
          val database = File(path).canonicalFile
          val container = File(context.applicationInfo.dataDir).canonicalPath + "/"
          if (!database.path.startsWith(container) ||
              !database.name.matches(Regex("synloquent_performance_[A-Za-z0-9_-]+\\.sqlite")))
            throw IOException("Native storage request is outside its task-owned database.")
          val result = JSONObject()
            .put("measurementId", measurementId)
            .put("path", path)
            .put("databaseBytes", database.length())
            .put("walBytes", File(path + "-wal").length())
          val callback = URL("http://127.0.0.1:8767/measurement/native-storage").openConnection() as HttpURLConnection
          connection = callback
          callback.requestMethod = "POST"
          callback.connectTimeout = 3000
          callback.readTimeout = 3000
          callback.doOutput = true
          callback.setRequestProperty("Content-Type", "application/json")
          callback.outputStream.use { it.write(result.toString().toByteArray(Charsets.UTF_8)) }
          responseCode = callback.responseCode
          val responseStream = if (responseCode == HttpURLConnection.HTTP_OK) callback.inputStream else callback.errorStream
          responseStream?.use { stream ->
            val buffer = ByteArray(maximumResponseBytes + 1)
            var receivedBytes = 0
            while (receivedBytes < buffer.size) {
              val received = stream.read(buffer, receivedBytes, buffer.size - receivedBytes)
              if (received < 0) break
              if (received == 0) throw IOException("Native storage callback response made no read progress.")
              receivedBytes += received
            }
            responseBody = String(buffer, 0, minOf(receivedBytes, maximumResponseBytes), Charsets.UTF_8)
            if (receivedBytes > maximumResponseBytes)
              throw IOException("Native storage callback response exceeded its byte bound.")
          }
          if (responseCode != HttpURLConnection.HTTP_OK)
            throw IOException("Native storage callback was rejected with HTTP " + responseCode + ".")
          if (JSONObject(responseBody).opt("accepted") != true)
            throw IOException("Native storage callback has no strict accepted acknowledgement.")
        } catch (failure: Exception) {
          recordFailure(path, measurementId, responseCode, responseBody, failure)
        } finally {
          try {
            connection?.disconnect()
          } catch (failure: Exception) {
            recordFailure(path, measurementId, responseCode, responseBody, failure)
          } finally { pending.finish() }
        }
      }
    } catch (failure: Exception) {
      try { recordFailure(path, measurementId, null, "", failure) } finally { pending.finish() }
    }
  }
  private fun receiveTaskDisk(context: Context, intent: Intent) {
    val encoded = intent.getStringExtra("payloadBase64") ?: return
    if (encoded.length > 32768) return
    val pending = goAsync()
    worker.execute {
      try {
        val raw = android.util.Base64.decode(encoded, android.util.Base64.NO_WRAP)
        require(raw.size <= 16384) { "Bounded native task disk command exceeded" }
        val command = JSONObject(String(raw, Charsets.UTF_8))
        val sessionName = command.getString("sessionName")
        val requestIdentity = command.getString("requestIdentity")
        require(sessionName.matches(Regex("synloquent-native-android-[A-Za-z0-9-]{1,128}")))
        require(requestIdentity.matches(Regex("[a-f0-9]{32}")))
        val result = JSONObject()
          .put("sessionName", sessionName)
          .put("requestIdentity", requestIdentity)
        try {
          val container = File(context.applicationInfo.dataDir).canonicalFile
          require(container.isDirectory)
          val mode = command.getString("mode")
          if (mode == "register") {
            val registration = command.getJSONObject("registration")
            val name = registration.getString("name")
            val path = registration.getString("path")
            val origin = registration.getString("origin")
            require(path.length <= 2048 && path.endsWith("/" + name))
            require(name.matches(Regex("synloquent_(fixture|performance|reference|large_http|batch_sync)_[A-Za-z0-9_-]+\\.sqlite")))
            if (taskSession != sessionName) {
              require(name.startsWith("synloquent_fixture_") && origin == "fixture adapter PRAGMA database_list")
              taskPaths.clear()
              taskSession = sessionName
            }
            require(taskPaths.size < 5 && !taskPaths.containsKey(name) && !taskPaths.values.contains(path))
            val prefixes = arrayOf("synloquent_fixture_", "synloquent_performance_", "synloquent_reference_", "synloquent_large_http_", "synloquent_batch_sync_")
            require(name.startsWith(prefixes[taskPaths.size]))
            require(origin == if (taskPaths.isEmpty()) "fixture adapter PRAGMA database_list" else "client owner.read PRAGMA database_list")
            validatePath(container, path, requireMain = true)
            taskPaths[name] = path
            result.put("accepted", true).put("name", name).put("path", path)
          } else {
            require(mode == "sample" && taskSession == sessionName)
            val requestedNames = command.getJSONArray("names")
            require(requestedNames.length() in 3..5 && requestedNames.length() == taskPaths.size)
            val names = taskPaths.keys.toList()
            val files = org.json.JSONArray()
            for (index in names.indices) {
              val name = names[index]
              require(requestedNames.getString(index) == name)
              val path = taskPaths.getValue(name)
              for ((kind, suffix) in listOf("main" to "", "wal" to "-wal", "shm" to "-shm")) {
                val observation = observeFile(container, path + suffix)
                files.put(JSONObject().put("name", name).put("kind", kind)
                  .put("status", observation.first)
                  .put("bytes", observation.second ?: JSONObject.NULL))
              }
            }
            result.put("accepted", true).put("files", files)
          }
        } catch (failure: Throwable) {
          result.put("accepted", false).put("error", failure.toString().take(512))
        }
        val responseBytes = result.toString().toByteArray(Charsets.UTF_8)
        require(responseBytes.size <= 16384)
        val connection = URL("http://127.0.0.1:8767/measurement/native-task-disk").openConnection() as HttpURLConnection
        try {
          connection.requestMethod = "POST"
          connection.connectTimeout = 1500
          connection.readTimeout = 1500
          connection.doOutput = true
          connection.setFixedLengthStreamingMode(responseBytes.size)
          connection.setRequestProperty("Content-Type", "application/json")
          connection.outputStream.use { it.write(responseBytes) }
          require(connection.responseCode == 200)
          connection.inputStream.use { input ->
            var bytes = 0
            val buffer = ByteArray(1024)
            while (true) {
              val count = input.read(buffer)
              if (count < 0) break
              bytes += count
              require(bytes <= 16384)
            }
          }
        } finally { connection.disconnect() }
      } finally { pending.finish() }
    }
  }

  private fun validatePath(container: File, path: String, requireMain: Boolean) {
    val file = File(path)
    require(file.isAbsolute && file.path == path && file.canonicalPath == path)
    require(path.startsWith(container.path + "/") && !path.split('/').contains(".."))
    var parent = file.parentFile
    while (parent != null && parent.path != container.path) {
      val status = android.system.Os.lstat(parent.path)
      require(android.system.OsConstants.S_ISDIR(status.st_mode))
      parent = parent.parentFile
    }
    require(parent?.path == container.path)
    if (requireMain) {
      val status = android.system.Os.lstat(path)
      require(android.system.OsConstants.S_ISREG(status.st_mode))
    }
  }

  private fun observeFile(container: File, path: String): Pair<String, Long?> {
    validatePath(container, path, requireMain = false)
    return try {
      val status = android.system.Os.lstat(path)
      require(android.system.OsConstants.S_ISREG(status.st_mode) && status.st_size >= 0)
      Pair("present", status.st_size)
    } catch (failure: android.system.ErrnoException) {
      if (failure.errno != android.system.OsConstants.ENOENT) throw failure
      Pair("absent", null)
    }
  }

  companion object {
    private var taskSession: String? = null
    private val taskPaths = linkedMapOf<String, String>()
    private val worker = Executors.newSingleThreadExecutor()
    private const val maximumResponseBytes = 4096

    private fun recordFailure(path: String, measurementId: String, responseCode: Int?, responseBody: String, failure: Exception) {
      val evidence = JSONObject()
        .put("schema", "synloquent-native-storage-callback-failure")
        .put("schemaVersion", 1)
        .put("path", path.take(512))
        .put("pathTruncated", path.length > 512)
        .put("measurementId", measurementId.take(64))
        .put("responseCode", responseCode ?: JSONObject.NULL)
        .put("responseBody", responseBody.take(192))
        .put("reason", (failure.message ?: failure.javaClass.simpleName).take(192))
      Log.e("ReactNativeJS", "Synloquent native storage callback failure " + evidence.toString())
    }
  }
}
