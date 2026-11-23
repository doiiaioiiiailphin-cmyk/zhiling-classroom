package com.zhiling.classroom.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.zhiling.classroom.BuildConfig
import com.zhiling.classroom.MainActivity
import com.zhiling.classroom.R
import com.zhiling.classroom.ai.ClassroomAiService
import com.zhiling.classroom.ai.LlmClient
import com.zhiling.classroom.audio.CloudAsrClient
import com.zhiling.classroom.audio.SenseVoiceEngine
import com.zhiling.classroom.audio.WavStorage
import com.zhiling.classroom.db.ClassroomDatabase
import com.zhiling.classroom.db.ClassroomRepository
import com.zhiling.classroom.db.CryptoBox
import com.zhiling.classroom.model.NativeAudioDevices
import com.zhiling.classroom.model.NativeAudioEndpoint
import com.zhiling.classroom.model.formatTimestampSec
import com.zhiling.classroom.settings.SettingsManager
import com.zhiling.classroom.update.AndroidUpdater
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * 安卓常驻前台引擎服务：
 * - 托管嵌入式 Ktor 127.0.0.1 服务、SQLite、AudioRecord 锁屏录音与 SenseVoice 离线转写；
 * - 录音期间自动切换为 MICROPHONE 前台服务类型并持有 PARTIAL_WAKE_LOCK，锁屏 3 小时不掉线；
 * - 通知栏实时显示录音计时，并提供「暂停」「标不懂」快捷按钮。
 */
class ClassroomEngineService : Service() {

    inner class LocalBinder : Binder() {
        fun service(): ClassroomEngineService = this@ClassroomEngineService
    }

    private val binder = LocalBinder()
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private lateinit var httpClient: OkHttpClient
    private lateinit var db: ClassroomDatabase
    lateinit var repo: ClassroomRepository
        private set
    lateinit var settingsManager: SettingsManager
        private set
    lateinit var wavStorage: WavStorage
        private set
    lateinit var senseVoice: SenseVoiceEngine
        private set
    lateinit var streamManager: StreamManager
        private set
    lateinit var updater: AndroidUpdater
        private set
    private lateinit var apiServer: LocalApiServer
    private lateinit var floatingOverlay: FloatingOverlayController

    private var wakeLock: PowerManager.WakeLock? = null
    private val projectionLock = Any()
    @Volatile
    private var activeMediaProjection: MediaProjection? = null
    @Volatile
    var serverPort: Int = 0
        private set

    @Volatile
    var apkInstallHandler: ((File) -> Boolean)? = null

    fun hasActiveMediaProjection(): Boolean = activeMediaProjection != null

    fun getActiveMediaProjection(): MediaProjection? = activeMediaProjection

    /**
     * Android 14+ (API 34+) 强约束：必须在调用 MediaProjectionManager.getMediaProjection 前
     * 启动携带 FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION 的前台服务，否则会抛出 SecurityException。
     */
    fun attachMediaProjection(resultCode: Int, data: Intent): Boolean = synchronized(projectionLock) {
        releaseMediaProjectionLocked()
        val snap = streamManager.activeSnapshot()
        val notif = if (snap != null && snap.isRecording) {
            buildRecordingNotification(snap.copy(systemAudioActive = true))
        } else {
            buildProjectionArmedNotification()
        }
        val fgType = computeForegroundType(
            includeMic = snap != null && snap.isRecording && snap.micActive,
            includeMediaProjection = true,
        )
        try {
            ServiceCompat.startForeground(this, NOTIF_ID, notif, fgType)
        } catch (_: Throwable) {
            return@synchronized false
        }
        return@synchronized try {
            val mgr = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            val proj = mgr.getMediaProjection(resultCode, data) ?: return@synchronized false
            proj.registerCallback(
                object : MediaProjection.Callback() {
                    override fun onStop() {
                        synchronized(projectionLock) {
                            if (activeMediaProjection === proj) {
                                activeMediaProjection = null
                            }
                        }
                        streamManager.onMediaProjectionRevoked()
                    }
                },
                Handler(Looper.getMainLooper()),
            )
            activeMediaProjection = proj
            true
        } catch (_: Throwable) {
            false
        }
    }

    fun releaseMediaProjection() = synchronized(projectionLock) {
        releaseMediaProjectionLocked()
    }

    private fun releaseMediaProjectionLocked() {
        val prev = activeMediaProjection
        activeMediaProjection = null
        if (prev != null) {
            runCatching { prev.stop() }
        }
    }

    fun findInputDeviceById(deviceId: String): AudioDeviceInfo? {
        if (deviceId.isBlank() || deviceId == "default") return null
        val am = getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return null
        val targetId = deviceId.toIntOrNull() ?: return null
        return am.getDevices(AudioManager.GET_DEVICES_INPUTS).firstOrNull { it.id == targetId }
    }

    fun listAudioDevices(): NativeAudioDevices {
        val inputs = mutableListOf(
            NativeAudioEndpoint(
                id = "default",
                rawId = "default",
                name = "手机内置麦克风（含硬件降噪）",
                isDefault = true,
                isCommunicationsDefault = true,
            )
        )
        runCatching {
            val am = getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return@runCatching
            val seen = mutableSetOf<String>()
            for (dev in am.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
                val label = describeInputDevice(dev) ?: continue
                if (seen.add(label)) {
                    inputs.add(
                        NativeAudioEndpoint(
                            id = dev.id.toString(),
                            rawId = dev.id.toString(),
                            name = label,
                            isDefault = false,
                            isCommunicationsDefault = false,
                        )
                    )
                }
            }
        }
        val loopbacks = listOf(
            NativeAudioEndpoint(
                id = "default",
                rawId = "android-playback-capture",
                name = "手机系统媒体声音内录（支持耳机/网课）",
                isDefault = true,
                isCommunicationsDefault = true,
            )
        )
        return NativeAudioDevices(
            platform = "android",
            wasapiSupported = true,
            inputs = inputs,
            loopbacks = loopbacks,
        )
    }

    private fun describeInputDevice(dev: AudioDeviceInfo): String? {
        val product = dev.productName?.toString()?.trim().orEmpty()
        return when (dev.type) {
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_BLE_HEADSET,
            -> if (product.isNotEmpty()) "蓝牙耳机麦克风（$product）" else "蓝牙耳机麦克风"
            AudioDeviceInfo.TYPE_WIRED_HEADSET ->
                if (product.isNotEmpty()) "有线耳机麦克风（$product）" else "有线耳机麦克风"
            AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_USB_DEVICE,
            -> if (product.isNotEmpty()) "USB 外接麦克风（$product）" else "USB 外接麦克风"
            else -> null
        }
    }

    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannel()

        val dataRoot = File(filesDir, "data").apply { mkdirs() }
        httpClient = OkHttpClient.Builder()
            .connectTimeout(25, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS) // SSE streaming requires no read timeout
            .writeTimeout(60, TimeUnit.SECONDS)
            .followRedirects(true)
            .build()

        db = ClassroomDatabase(this, File(dataRoot, "classroom.sqlite3"))
        val crypto = CryptoBox()
        settingsManager = SettingsManager(db, crypto)
        repo = ClassroomRepository(db, File(dataRoot, "attachments"))
        wavStorage = WavStorage(File(dataRoot, "audio"))
        senseVoice = SenseVoiceEngine(File(dataRoot, "models"), httpClient)
        val cloudAsr = CloudAsrClient(httpClient)
        val llmClient = LlmClient(httpClient)
        val aiService = ClassroomAiService(repo, settingsManager, llmClient)

        updater = AndroidUpdater(
            http = httpClient,
            updatesDir = File(filesDir, "updates"),
            currentVersion = BuildConfig.APP_VERSION_NAME,
            repo = BuildConfig.CNB_REPO,
            onRequestApkInstall = { apk -> apkInstallHandler?.invoke(apk) ?: false },
        )

        streamManager = StreamManager(
            scope = serviceScope,
            repo = repo,
            settingsManager = settingsManager,
            wavStorage = wavStorage,
            senseVoice = senseVoice,
            cloudAsr = cloudAsr,
            aiService = aiService,
            onRecordingStateChanged = { snap -> updateForegroundForRecording(snap) },
            mediaProjectionProvider = { getActiveMediaProjection() },
            preferredMicDeviceResolver = { id -> findInputDeviceById(id) },
        )

        apiServer = LocalApiServer(
            assets = assets,
            repo = repo,
            settingsManager = settingsManager,
            wavStorage = wavStorage,
            senseVoice = senseVoice,
            cloudAsr = cloudAsr,
            llmClient = llmClient,
            aiService = aiService,
            streams = streamManager,
            updater = updater,
            audioDevicesProvider = { listAudioDevices() },
        )
        serverPort = apiServer.start()
        currentPort = serverPort
        floatingOverlay = FloatingOverlayController(this) { serverPort }
    }

    fun toggleFloatingOverlay(): Boolean =
        if (::floatingOverlay.isInitialized) floatingOverlay.toggle() else false

    fun isFloatingOverlayShowing(): Boolean =
        ::floatingOverlay.isInitialized && floatingOverlay.isShowing()

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        if (::floatingOverlay.isInitialized) {
            floatingOverlay.onDisplayBoundsChanged()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PAUSE_RECORDING -> streamManager.toggleRecordingFromNotification()
            ACTION_BOOKMARK_CONFUSED -> streamManager.bookmarkConfusedFromNotification()
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        releaseWakeLock()
        if (::floatingOverlay.isInitialized) {
            runCatching { floatingOverlay.hide() }
        }
        runCatching { streamManager.stopRecording() }
        releaseMediaProjection()
        runCatching { apiServer.stop() }
        runCatching { senseVoice.release() }
        runCatching { db.close() }
        serviceScope.cancel()
        currentPort = 0
        super.onDestroy()
    }

    private fun computeForegroundType(includeMic: Boolean, includeMediaProjection: Boolean): Int {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return 0
        var mask = 0
        if (includeMediaProjection) {
            mask = mask or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        }
        if (includeMic && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            mask = mask or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        }
        if (mask == 0 && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            mask = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        }
        return mask
    }

    private fun updateForegroundForRecording(snap: ActiveRecordingSnapshot?) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (snap != null && snap.isRecording) {
            acquireWakeLock()
            val notif = buildRecordingNotification(snap)
            val fgType = computeForegroundType(
                includeMic = snap.micActive || !snap.systemAudioActive,
                includeMediaProjection = snap.systemAudioActive && hasActiveMediaProjection(),
            )
            try {
                ServiceCompat.startForeground(this, NOTIF_ID, notif, fgType)
            } catch (_: Throwable) {
                nm.notify(NOTIF_ID, notif)
            }
        } else {
            releaseWakeLock()
            releaseMediaProjection()
            try {
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            } catch (_: Throwable) {
                nm.cancel(NOTIF_ID)
            }
        }
    }

    private fun buildProjectionArmedNotification(): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_zhiling)
            .setContentTitle("知聆课堂 · 系统内录已就绪")
            .setContentText("正在准备捕获手机系统媒体声音...")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openIntent)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun buildRecordingNotification(snap: ActiveRecordingSnapshot): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val pauseIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, ClassroomEngineService::class.java).setAction(ACTION_PAUSE_RECORDING),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val markIntent = PendingIntent.getService(
            this,
            2,
            Intent(this, ClassroomEngineService::class.java).setAction(ACTION_BOOKMARK_CONFUSED),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val timeText = formatTimestampSec(snap.durationSeconds)
        val modeHint = when {
            snap.micActive && snap.systemAudioActive -> "麦克风 + 系统内录转写中"
            snap.systemAudioActive -> "系统内录持续转写中"
            else -> "锁屏持续转写中"
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_zhiling)
            .setContentTitle("正在录课 · ${snap.sessionTitle}")
            .setContentText("已录制 $timeText · $modeHint")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openIntent)
            .addAction(0, "标不懂", markIntent)
            .addAction(0, "暂停录音", pauseIntent)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun ensureNotificationChannel() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
            CHANNEL_ID,
            "课堂后台录音",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "锁屏或切换应用时持续录音并实时转写"
            setShowBadge(false)
        }
        nm.createNotificationChannel(channel)
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ZhilingClassroom::RecordingLock").apply {
            setReferenceCounted(false)
            acquire(4 * 60 * 60 * 1000L) // Up to 4 hours safety timeout
        }
    }

    private fun releaseWakeLock() {
        runCatching {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        }
        wakeLock = null
    }

    companion object {
        const val CHANNEL_ID = "zhiling_recording_channel"
        const val NOTIF_ID = 1101
        const val ACTION_PAUSE_RECORDING = "com.zhiling.classroom.action.PAUSE_RECORDING"
        const val ACTION_BOOKMARK_CONFUSED = "com.zhiling.classroom.action.BOOKMARK_CONFUSED"

        @Volatile
        var currentPort: Int = 0
            private set
    }
}
