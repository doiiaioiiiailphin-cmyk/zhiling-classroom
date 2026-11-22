package com.zhiling.classroom.update

import com.zhiling.classroom.model.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest

/**
 * 与桌面端 backend/app/services/updater.py 共享同一套 CNB 公开 Release 更新源，
 * 匹配 ZhilingClassroom-Android-arm64.apk，校验 SHA-256 后交给系统安装器完成应用内更新。
 */
class AndroidUpdater(
    private val http: OkHttpClient,
    private val updatesDir: File,
    private val currentVersion: String,
    private val repo: String = "dolphin114/zhiling-classroom",
    private val onRequestApkInstall: ((File) -> Boolean)? = null,
) {
    @Volatile
    private var lastCheck: UpdateCheckResult? = null

    @Volatile
    private var stagedApk: File? = null

    init {
        updatesDir.mkdirs()
    }

    fun checkUpdate(force: Boolean = false): UpdateCheckResult {
        val prev = lastCheck
        if (!force && prev != null) return prev
        val url = "https://cnb.cool/$repo/-/releases/latest"
        val req = Request.Builder()
            .url(url)
            .header("Accept", "application/vnd.cnb.web+json")
            .header("User-Agent", "ZhilingClassroom-Android/$currentVersion")
            .get()
            .build()

        val result = try {
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) {
                    throw AppException(502, "UPDATE_CHECK_FAILED", "检查更新失败（HTTP ${resp.code}）")
                }
                val body = resp.body?.string().orEmpty()
                parseReleasePayload(body)
            }
        } catch (e: AppException) {
            throw e
        } catch (e: Throwable) {
            throw AppException(502, "UPDATE_CHECK_FAILED", "无法连接更新源：${e.message ?: "网络异常"}")
        }
        lastCheck = result
        return result
    }

    fun parseReleasePayload(rawJson: String): UpdateCheckResult {
        val root = WireJson.parseToJsonElement(rawJson).jsonObject
        val relObj = root["release"]?.jsonObject ?: root
        val tagRef = relObj["tag_ref"]?.jsonPrimitive?.contentOrNull
            ?: relObj["tag_name"]?.jsonPrimitive?.contentOrNull
            ?: ""
        val latestVer = tagRef.substringAfterLast("/").removePrefix("v").trim().ifBlank { currentVersion }
        val title = relObj["title"]?.jsonPrimitive?.contentOrNull
            ?: relObj["name"]?.jsonPrimitive?.contentOrNull
            ?: "知聆课堂 v$latestVer"
        val notes = relObj["body"]?.jsonPrimitive?.contentOrNull ?: ""
        val publishedAt = relObj["published_at"]?.jsonPrimitive?.contentOrNull ?: ""
        val assetsArr = relObj["assets"]?.jsonArray ?: JsonArray(emptyList())

        val candidates = assetsArr.mapNotNull { el ->
            val obj = el.jsonObject
            val name = obj["name"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val path = obj["path"]?.jsonPrimitive?.contentOrNull ?: ""
            val downloadUrl = when {
                path.startsWith("http://") || path.startsWith("https://") -> path
                path.startsWith("/") -> "https://cnb.cool$path"
                else -> "https://cnb.cool/$repo/-/releases/download/v$latestVer/$name"
            }
            val size = obj["size_in_byte"]?.jsonPrimitive?.longOrNull
                ?: obj["size"]?.jsonPrimitive?.longOrNull
                ?: 0L
            val sha = obj["hash"]?.jsonPrimitive?.contentOrNull
                ?: obj["sha256"]?.jsonPrimitive?.contentOrNull
                ?: ""
            UpdateAssetInfo(name = name, sizeBytes = size, sha256 = sha, downloadUrl = downloadUrl)
        }

        val asset = selectAndroidAsset(candidates)
        val hasUpdate = compareSemver(latestVer, currentVersion) > 0 && asset != null
        val existingStaged = asset?.let { File(updatesDir, "${latestVer}_${it.name}") }
        val isStagedReady = existingStaged != null && existingStaged.isFile && existingStaged.length() > 0L
        if (isStagedReady) stagedApk = existingStaged

        return UpdateCheckResult(
            currentVersion = currentVersion,
            latestVersion = latestVer,
            hasUpdate = hasUpdate,
            releaseTitle = title,
            releaseNotes = notes,
            releaseUrl = "https://cnb.cool/$repo/-/releases/tag/v$latestVer",
            publishedAt = publishedAt,
            platform = "android",
            arch = "arm64",
            repo = repo,
            canAutoApply = true,
            stagedReady = isStagedReady,
            asset = asset,
            checkedAt = nowIsoUtc(),
        )
    }

    fun downloadUpdateStream(): Flow<JsonObject> = flow {
        val info = checkUpdate(force = false)
        val asset = info.asset ?: throw AppException(404, "UPDATE_ASSET_MISSING", "当前版本未提供 Android APK 安装包")

        emit(buildJsonObject {
            put("type", "progress")
            put("stage", "connecting")
            put("downloadedBytes", 0L)
            put("totalBytes", asset.sizeBytes)
            put("percent", 0)
            put("speedBytesPerSec", 0L)
        })

        val target = File(updatesDir, "${info.latestVersion}_${asset.name}")
        val part = File(updatesDir, "${info.latestVersion}_${asset.name}.part")
        val req = Request.Builder()
            .url(asset.downloadUrl)
            .header("User-Agent", "ZhilingClassroom-Android/$currentVersion")
            .get()
            .build()

        val digest = MessageDigest.getInstance("SHA-256")
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                throw AppException(502, "UPDATE_DOWNLOAD_FAILED", "下载安装包失败（HTTP ${resp.code}）")
            }
            val body = resp.body ?: throw AppException(502, "UPDATE_DOWNLOAD_FAILED", "响应体为空")
            val total = body.contentLength().takeIf { it > 0L } ?: asset.sizeBytes
            var downloaded = 0L
            val startedAt = System.nanoTime()
            var lastEmitNs = 0L
            part.outputStream().use { out ->
                body.byteStream().use { input ->
                    val buf = ByteArray(65536)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        out.write(buf, 0, n)
                        digest.update(buf, 0, n)
                        downloaded += n
                        val nowNs = System.nanoTime()
                        if (nowNs - lastEmitNs >= 120_000_000L) {
                            lastEmitNs = nowNs
                            val elapsedSec = ((nowNs - startedAt) / 1e9).coerceAtLeast(0.05)
                            val speed = (downloaded / elapsedSec).toLong()
                            val pct = if (total > 0L) ((downloaded * 100L) / total).toInt().coerceIn(0, 99) else 0
                            emit(buildJsonObject {
                                put("type", "progress")
                                put("stage", "downloading")
                                put("downloadedBytes", downloaded)
                                put("totalBytes", total)
                                put("percent", pct)
                                put("speedBytesPerSec", speed)
                            })
                        }
                    }
                }
            }
            emit(buildJsonObject {
                put("type", "progress")
                put("stage", "verifying")
                put("downloadedBytes", downloaded)
                put("totalBytes", total)
                put("percent", 99)
                put("speedBytesPerSec", 0L)
            })
        }

        val actualSha = digest.digest().joinToString("") { "%02x".format(it) }
        if (asset.sha256.length == 64 && !actualSha.equals(asset.sha256, ignoreCase = true)) {
            part.delete()
            throw AppException(502, "UPDATE_SHA256_MISMATCH", "安装包 SHA-256 校验失败，已自动拦截")
        }
        if (target.exists()) target.delete()
        part.renameTo(target)
        stagedApk = target

        val readyInfo = info.copy(stagedReady = true)
        lastCheck = readyInfo
        emit(buildJsonObject {
            put("type", "done")
            put("data", WireJson.encodeToJsonElement(readyInfo))
        })
    }.flowOn(Dispatchers.IO)

    fun applyStagedUpdate(): UpdateApplyResult {
        val info = lastCheck ?: throw AppException(400, "NO_STAGED_UPDATE", "请先下载更新包")
        val apk = stagedApk?.takeIf { it.isFile }
            ?: throw AppException(400, "NO_STAGED_UPDATE", "未找到已校验的安装包文件")
        val launched = onRequestApkInstall?.invoke(apk) ?: false
        return UpdateApplyResult(
            scheduled = launched,
            mode = if (launched) "auto-replace" else "dev-manual",
            version = info.latestVersion,
            downloadPath = apk.absolutePath,
            message = if (launched) "已拉起系统安装器，请确认安装新版本" else "安装包已就绪，请手动安装",
        )
    }

    companion object {
        fun selectAndroidAsset(assets: List<UpdateAssetInfo>): UpdateAssetInfo? {
            val apks = assets.filter { it.name.endsWith(".apk", ignoreCase = true) }
            if (apks.isEmpty()) return null
            return apks.firstOrNull { it.name.contains("arm64", ignoreCase = true) }
                ?: apks.firstOrNull { it.name.contains("android", ignoreCase = true) }
                ?: apks.first()
        }

        fun compareSemver(a: String, b: String): Int {
            fun parse(v: String): List<Int> =
                v.trim().removePrefix("v").substringBefore("-").split(".")
                    .map { it.filter(Char::isDigit).toIntOrNull() ?: 0 }
            val pa = parse(a)
            val pb = parse(b)
            val n = maxOf(pa.size, pb.size, 3)
            for (i in 0 until n) {
                val diff = pa.getOrElse(i) { 0 }.compareTo(pb.getOrElse(i) { 0 })
                if (diff != 0) return diff
            }
            return 0
        }
    }
}
