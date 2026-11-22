package com.zhiling.classroom

import android.Manifest
import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.provider.Settings
import android.util.Base64
import android.view.ViewGroup
import android.webkit.*
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.zhiling.classroom.service.ClassroomEngineService
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * 知聆课堂 Android 主窗口：
 * - Edge-to-Edge 全屏 WebView 承载复用自桌面端的响应式 React 前端（从 127.0.0.1 加载）；
 * - 提供 window.ZhilingAndroid 原生桥：录音权限、原生相机拍板书、系统分享导出文档与 APK 安装器。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var engineService: ClassroomEngineService? = null
    private var serviceBound = false
    private var webLoaded = false

    private var pendingFileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var pendingCameraFile: File? = null
    private var pendingCameraCallbackId: String? = null
    private var pendingPermissionCallbackId: String? = null

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { results ->
        val micGranted = results[Manifest.permission.RECORD_AUDIO]
            ?: (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
        val cbId = pendingPermissionCallbackId
        pendingPermissionCallbackId = null
        if (cbId != null) {
            resolveJsCallback(cbId, buildJsonObject { put("granted", micGranted) }.toString())
        }
    }

    private val cameraPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            launchNativeCameraInternal()
        } else {
            val cbId = pendingCameraCallbackId
            pendingCameraCallbackId = null
            if (cbId != null) {
                resolveJsCallback(cbId, buildJsonObject { put("error", "未授予相机权限") }.toString())
            }
        }
    }

    private val cameraLauncher = registerForActivityResult(
        ActivityResultContracts.TakePicture(),
    ) { success ->
        val file = pendingCameraFile
        val cbId = pendingCameraCallbackId
        pendingCameraFile = null
        pendingCameraCallbackId = null
        if (cbId == null) return@registerForActivityResult
        if (!success || file == null || !file.isFile || file.length() == 0L) {
            resolveJsCallback(cbId, buildJsonObject { put("cancelled", true) }.toString())
            return@registerForActivityResult
        }
        Thread {
            val compressed = compressBlackboardPhoto(file)
            file.delete()
            val b64 = Base64.encodeToString(compressed, Base64.NO_WRAP)
            val json = buildJsonObject {
                put("fileName", "blackboard_${System.currentTimeMillis()}.jpg")
                put("mimeType", "image/jpeg")
                put("base64", b64)
            }.toString()
            runOnUiThread { resolveJsCallback(cbId, json) }
        }.start()
    }

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { res ->
        val cb = pendingFileChooserCallback
        pendingFileChooserCallback = null
        val uris = WebChromeClient.FileChooserParams.parseResult(res.resultCode, res.data)
        cb?.onReceiveValue(uris)
    }

    private val serviceConn = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val svc = (binder as? ClassroomEngineService.LocalBinder)?.service() ?: return
            engineService = svc
            svc.apkInstallHandler = { apk -> triggerApkInstall(apk) }
            val port = svc.serverPort
            if (port > 0 && !webLoaded) {
                webLoaded = true
                webView.loadUrl("http://127.0.0.1:$port/?platform=android")
            }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            engineService = null
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }

        val root = FrameLayout(this).apply {
            setBackgroundColor(0xFFFFFFFF.toInt())
        }
        webView = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            setBackgroundColor(0xFFFFFFFF.toInt())
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = false
                allowContentAccess = true
                mediaPlaybackRequiresUserGesture = false
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                cacheMode = WebSettings.LOAD_DEFAULT
                textZoom = 100
            }
            addJavascriptInterface(AndroidJsBridge(), "ZhilingAndroid")
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val uri = request?.url ?: return false
                    if (uri.host == "127.0.0.1" || uri.host == "localhost") return false
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                    return true
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    applySafeAreaInsetsToCss()
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest?) {
                    request?.grant(request.resources)
                }

                override fun onShowFileChooser(
                    webView: WebView?,
                    filePathCallback: ValueCallback<Array<Uri>>?,
                    fileChooserParams: FileChooserParams?,
                ): Boolean {
                    pendingFileChooserCallback?.onReceiveValue(null)
                    pendingFileChooserCallback = filePathCallback
                    return try {
                        val intent = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                            type = "*/*"
                            addCategory(Intent.CATEGORY_OPENABLE)
                        }
                        fileChooserLauncher.launch(intent)
                        true
                    } catch (_: Throwable) {
                        pendingFileChooserCallback = null
                        false
                    }
                }
            }
        }
        root.addView(webView)
        setContentView(root)

        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime()
            )
            val density = resources.displayMetrics.density
            safeTopDp = bars.top / density
            safeBottomDp = bars.bottom / density
            applySafeAreaInsetsToCss()
            insets
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript(
                    "(window.__zhilingHandleAndroidBack && window.__zhilingHandleAndroidBack()) ? 'handled' : 'exit'"
                ) { result ->
                    if (result == null || !result.contains("handled")) {
                        moveTaskToBack(true)
                    }
                }
            }
        })

        // Start & bind background engine service
        val svcIntent = Intent(this, ClassroomEngineService::class.java)
        startService(svcIntent)
        bindService(svcIntent, serviceConn, Context.BIND_AUTO_CREATE)
    }

    override fun onDestroy() {
        if (serviceBound) {
            unbindService(serviceConn)
            serviceBound = false
        }
        webView.destroy()
        super.onDestroy()
    }

    override fun onStart() {
        super.onStart()
        if (!serviceBound) {
            serviceBound = bindService(
                Intent(this, ClassroomEngineService::class.java),
                serviceConn,
                Context.BIND_AUTO_CREATE,
            )
        }
    }

    private var safeTopDp: Float = 0f
    private var safeBottomDp: Float = 0f

    private fun applySafeAreaInsetsToCss() {
        val js = """
            (function(){
              var r = document.documentElement;
              if (!r) return;
              r.style.setProperty('--android-safe-top', '${"%.1f".format(safeTopDp)}px');
              r.style.setProperty('--android-safe-bottom', '${"%.1f".format(safeBottomDp)}px');
            })();
        """.trimIndent()
        runOnUiThread {
            if (::webView.isInitialized) webView.evaluateJavascript(js, null)
        }
    }

    private fun resolveJsCallback(callbackId: String, payloadJson: String) {
        val escaped = payloadJson
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", "\\n")
            .replace("\r", "")
        val js = "window.__zhilingAndroidResolve && window.__zhilingAndroidResolve('$callbackId', '$escaped');"
        webView.evaluateJavascript(js, null)
    }

    private fun launchNativeCameraInternal() {
        val cacheDir = File(cacheDir, "camera").apply { mkdirs() }
        val photoFile = File(cacheDir, "snap_${System.currentTimeMillis()}.jpg")
        pendingCameraFile = photoFile
        val uri = FileProvider.getUriForFile(this, "${packageName}.fileprovider", photoFile)
        cameraLauncher.launch(uri)
    }

    private fun compressBlackboardPhoto(file: File): ByteArray {
        val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, opts)
        val maxDim = maxOf(opts.outWidth, opts.outHeight)
        var sample = 1
        while (maxDim / sample > 1920) sample *= 2
        val decodeOpts = BitmapFactory.Options().apply { inSampleSize = sample }
        val bmp = BitmapFactory.decodeFile(file.absolutePath, decodeOpts) ?: return file.readBytes()
        return ByteArrayOutputStream().use { out ->
            bmp.compress(Bitmap.CompressFormat.JPEG, 86, out)
            bmp.recycle()
            out.toByteArray()
        }
    }

    private fun triggerApkInstall(apkFile: File): Boolean {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !packageManager.canRequestPackageInstalls()) {
                val settingsIntent = Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:$packageName"),
                ).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
                startActivity(settingsIntent)
                return true
            }
            val uri = FileProvider.getUriForFile(this, "${packageName}.fileprovider", apkFile)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(intent)
            true
        } catch (_: Throwable) {
            false
        }
    }

    private inner class AndroidJsBridge {

        @JavascriptInterface
        fun getAppVersion(): String = BuildConfig.APP_VERSION_NAME

        @JavascriptInterface
        fun hasRecordPermission(): Boolean =
            ContextCompat.checkSelfPermission(
                this@MainActivity,
                Manifest.permission.RECORD_AUDIO,
            ) == PackageManager.PERMISSION_GRANTED

        @JavascriptInterface
        fun requestRecordPermission(callbackId: String) {
            runOnUiThread {
                val perms = mutableListOf(Manifest.permission.RECORD_AUDIO)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    perms.add(Manifest.permission.POST_NOTIFICATIONS)
                }
                val allGranted = perms.all {
                    ContextCompat.checkSelfPermission(this@MainActivity, it) == PackageManager.PERMISSION_GRANTED
                }
                if (allGranted) {
                    resolveJsCallback(callbackId, buildJsonObject { put("granted", true) }.toString())
                } else {
                    pendingPermissionCallbackId = callbackId
                    permissionLauncher.launch(perms.toTypedArray())
                }
            }
        }

        @JavascriptInterface
        fun captureBlackboardPhoto(callbackId: String) {
            runOnUiThread {
                pendingCameraCallbackId = callbackId
                if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    launchNativeCameraInternal()
                } else {
                    cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                }
            }
        }

        @JavascriptInterface
        fun shareExportedFile(fileName: String, mimeType: String, contentBase64: String): Boolean {
            return try {
                val bytes = Base64.decode(contentBase64, Base64.DEFAULT)
                val outDir = File(cacheDir, "exports").apply { mkdirs() }
                val safeName = fileName.replace(Regex("""[\\/:*?"<>|]"""), "_").ifBlank { "export.md" }
                val outFile = File(outDir, safeName)
                outFile.writeBytes(bytes)
                val uri = FileProvider.getUriForFile(this@MainActivity, "${packageName}.fileprovider", outFile)
                val share = Intent(Intent.ACTION_SEND).apply {
                    type = mimeType.substringBefore(";").ifBlank { "*/*" }
                    putExtra(Intent.EXTRA_STREAM, uri)
                    putExtra(Intent.EXTRA_SUBJECT, safeName)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                runOnUiThread {
                    startActivity(Intent.createChooser(share, "分享或保存课堂文档"))
                }
                true
            } catch (_: Throwable) {
                false
            }
        }
    }
}
