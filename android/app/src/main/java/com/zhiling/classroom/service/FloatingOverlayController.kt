package com.zhiling.classroom.service

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Choreographer
import android.view.Gravity
import android.view.MotionEvent
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import com.zhiling.classroom.MainActivity
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * 纯 Kotlin 悬浮窗坐标/横竖屏夹紧与吸边计算器（JVM 单测可覆盖）。
 */
object OverlayBoundsMath {
    data class RectPx(val x: Int, val y: Int, val width: Int, val height: Int)

    fun clampExpanded(
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        screenW: Int,
        screenH: Int,
        minW: Int,
        minH: Int,
        marginPx: Int,
    ): RectPx {
        val maxW = (screenW - marginPx * 2).coerceAtLeast(minW)
        val maxH = (screenH - marginPx * 2).coerceAtLeast(minH)
        val clampedW = width.coerceIn(minW, maxW)
        val clampedH = height.coerceIn(minH, maxH)
        val clampedX = x.coerceIn(marginPx, (screenW - clampedW - marginPx).coerceAtLeast(marginPx))
        val clampedY = y.coerceIn(marginPx, (screenH - clampedH - marginPx).coerceAtLeast(marginPx))
        return RectPx(clampedX, clampedY, clampedW, clampedH)
    }

    fun snapBubbleX(centerX: Int, screenW: Int, bubbleW: Int, marginPx: Int): Int {
        return if (centerX < screenW / 2) {
            marginPx
        } else {
            (screenW - bubbleW - marginPx).coerceAtLeast(marginPx)
        }
    }

    /**
     * 悬浮球展开为小窗时，以悬浮球移动后的当前位置为锚点（右半屏右对齐展开、左半屏左对齐展开），
     * 并自动夹紧至屏幕安全区域，避免跳回收起前的旧位置或超出屏幕边缘。
     */
    fun expandFromBubble(
        bubbleX: Int,
        bubbleY: Int,
        bubbleW: Int,
        targetW: Int,
        targetH: Int,
        screenW: Int,
        screenH: Int,
        minW: Int,
        minH: Int,
        marginPx: Int,
    ): RectPx {
        val maxW = (screenW - marginPx * 2).coerceAtLeast(minW)
        val clampedW = targetW.coerceIn(minW, maxW)
        val bubbleOnRight = bubbleX + bubbleW / 2 >= screenW / 2
        val desiredX = if (bubbleOnRight) bubbleX + bubbleW - clampedW else bubbleX
        return clampExpanded(
            x = desiredX,
            y = bubbleY,
            width = targetW,
            height = targetH,
            screenW = screenW,
            screenH = screenH,
            minW = minW,
            minH = minH,
            marginPx = marginPx,
        )
    }
}

/**
 * 纯 Kotlin 四阶龙格-库塔（RK4）物理弹簧引擎，供 Android 原生 Choreographer 与 JVM 单测共用。
 */
object OverlaySpringMath {
    data class SpringState(val value: Double, val velocity: Double, val settled: Boolean)

    private fun rk4Substep(
        x: Double,
        v: Double,
        target: Double,
        dt: Double,
        stiffness: Double,
        damping: Double,
        invMass: Double,
    ): Pair<Double, Double> {
        fun accel(pos: Double, vel: Double): Double =
            (-stiffness * (pos - target) - damping * vel) * invMass

        val k1x = v
        val k1v = accel(x, v)

        val halfDt = dt * 0.5
        val x2 = x + k1x * halfDt
        val v2 = v + k1v * halfDt
        val k2x = v2
        val k2v = accel(x2, v2)

        val x3 = x + k2x * halfDt
        val v3 = v + k2v * halfDt
        val k3x = v3
        val k3v = accel(x3, v3)

        val x4 = x + k3x * dt
        val v4 = v + k3v * dt
        val k4x = v4
        val k4v = accel(x4, v4)

        val nextX = x + ((k1x + 2.0 * k2x + 2.0 * k3x + k4x) * dt) / 6.0
        val nextV = v + ((k1v + 2.0 * k2v + 2.0 * k3v + k4v) * dt) / 6.0
        return nextX to nextV
    }

    fun stepSpring(
        value: Double,
        velocity: Double,
        target: Double,
        dtSeconds: Double,
        stiffness: Double = 380.0,
        damping: Double = 32.0,
        mass: Double = 1.0,
        restDisplacementThreshold: Double = 0.45,
        restVelocityThreshold: Double = 0.8,
    ): SpringState {
        val clampedDt = dtSeconds.coerceIn(0.0, 0.05)
        if (clampedDt <= 0.0) {
            val atRest = abs(value - target) <= restDisplacementThreshold &&
                abs(velocity) <= restVelocityThreshold
            return SpringState(
                value = if (atRest) target else value,
                velocity = if (atRest) 0.0 else velocity,
                settled = atRest,
            )
        }

        val maxSubstep = 1.0 / 120.0
        val steps = max(1, ceil(clampedDt / maxSubstep).toInt())
        val subDt = clampedDt / steps
        val invMass = 1.0 / max(mass, 0.01)

        var x = value
        var v = velocity
        repeat(steps) {
            val stepped = rk4Substep(x, v, target, subDt, stiffness, damping, invMass)
            x = stepped.first
            v = stepped.second
        }

        return if (abs(x - target) <= restDisplacementThreshold &&
            abs(v) <= restVelocityThreshold
        ) {
            SpringState(value = target, velocity = 0.0, settled = true)
        } else {
            SpringState(value = x, velocity = v, settled = false)
        }
    }
}

/**
 * Android 原生系统级全局悬浮窗控制器（TYPE_APPLICATION_OVERLAY）：
 * - 驻留在 ClassroomEngineService 内，切至 B 站/腾讯会议/雨课堂等任意网课应用时依然置顶显示；
 * - 承载独立透明 WebView（?mode=mini&platform=android&nativeOverlay=1），支持实时字幕、快捷 AI 对话、收起吸边悬浮球；
 * - 默认 FLAG_NOT_FOCUSABLE 不抢占底层网课应用焦点，点击 AI 输入框时自动切为可聚焦拉起输入法，点击窗外自动释放焦点；
 * - 自动响应手机/平板横竖屏旋转，重新夹紧尺寸与吸边位置。
 */
class FloatingOverlayController(
    private val context: Context,
    private val portProvider: () -> Int,
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager

    private var container: FrameLayout? = null
    private var webView: WebView? = null
    private var layoutParams: WindowManager.LayoutParams? = null

    @Volatile
    private var showing = false
    private var collapsed = false
    private var focusable = false
    private var aiExpanded = false

    private var savedExpandedX = 0
    private var savedExpandedY = 0
    private var savedExpandedW = 0
    private var savedExpandedH = 0
    private var preAiHeightPx = 0

    // Choreographer 120Hz RK4 悬浮窗几何弹簧状态
    private var springAnimating = false
    private var animLastFrameNanos = 0L
    private var springX = 0.0
    private var springY = 0.0
    private var springW = 0.0
    private var springH = 0.0
    private var velX = 0.0
    private var velY = 0.0
    private var velW = 0.0
    private var velH = 0.0
    private var targetX = 0.0
    private var targetY = 0.0
    private var targetW = 0.0
    private var targetH = 0.0

    private val springFrameCallback = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            if (!springAnimating) return
            val params = layoutParams ?: run {
                springAnimating = false
                return
            }
            val dtSec = if (animLastFrameNanos == 0L) {
                1.0 / 60.0
            } else {
                ((frameTimeNanos - animLastFrameNanos) / 1_000_000_000.0).coerceIn(0.001, 0.05)
            }
            animLastFrameNanos = frameTimeNanos

            val sx = OverlaySpringMath.stepSpring(springX, velX, targetX, dtSec, stiffness = 400.0, damping = 33.0)
            val sy = OverlaySpringMath.stepSpring(springY, velY, targetY, dtSec, stiffness = 400.0, damping = 33.0)
            val sw = OverlaySpringMath.stepSpring(springW, velW, targetW, dtSec, stiffness = 400.0, damping = 33.0)
            val sh = OverlaySpringMath.stepSpring(springH, velH, targetH, dtSec, stiffness = 400.0, damping = 33.0)

            springX = sx.value; velX = sx.velocity
            springY = sy.value; velY = sy.velocity
            springW = sw.value; velW = sw.velocity
            springH = sh.value; velH = sh.velocity

            params.x = springX.roundToInt()
            params.y = springY.roundToInt()
            params.width = springW.roundToInt().coerceAtLeast(1)
            params.height = sh.value.roundToInt().coerceAtLeast(1)
            updateWindowLayoutSafe()

            if (sx.settled && sy.settled && sw.settled && sh.settled) {
                springAnimating = false
                animLastFrameNanos = 0L
            } else {
                Choreographer.getInstance().postFrameCallback(this)
            }
        }
    }

    private fun stopSpringOnMain() {
        if (!springAnimating) return
        springAnimating = false
        animLastFrameNanos = 0L
        Choreographer.getInstance().removeFrameCallback(springFrameCallback)
    }

    private fun animateLayoutToOnMain(
        destX: Int,
        destY: Int,
        destW: Int,
        destH: Int,
    ) {
        val params = layoutParams ?: return
        if (!springAnimating) {
            springX = params.x.toDouble()
            springY = params.y.toDouble()
            springW = params.width.toDouble()
            springH = params.height.toDouble()
            velX = 0.0
            velY = 0.0
            velW = 0.0
            velH = 0.0
        }
        targetX = destX.toDouble()
        targetY = destY.toDouble()
        targetW = destW.toDouble()
        targetH = destH.toDouble()

        if (!springAnimating) {
            springAnimating = true
            animLastFrameNanos = 0L
            Choreographer.getInstance().postFrameCallback(springFrameCallback)
        }
    }

    fun isShowing(): Boolean = showing

    fun toggle(): Boolean {
        return if (showing) {
            hide()
            false
        } else {
            show()
        }
    }

    fun show(): Boolean {
        if (!Settings.canDrawOverlays(context)) return false
        if (showing) return true
        val port = portProvider()
        if (port <= 0) return false

        showing = true
        mainHandler.post { attachOverlayOnMain(port) }
        return true
    }

    fun hide() {
        if (!showing && container == null) return
        showing = false
        collapsed = false
        focusable = false
        aiExpanded = false
        mainHandler.post { detachOverlayOnMain() }
    }

    fun onDisplayBoundsChanged() {
        if (!showing) return
        mainHandler.post { clampLayoutToCurrentDisplay() }
    }

    private fun density(): Float = context.resources.displayMetrics.density

    private fun dp(value: Float): Int = (value * density()).roundToInt()

    private fun screenSize(): Pair<Int, Int> {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val b = windowManager.currentWindowMetrics.bounds
            b.width() to b.height()
        } else {
            val dm = context.resources.displayMetrics
            dm.widthPixels to dm.heightPixels
        }
    }

    @SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
    private fun attachOverlayOnMain(port: Int) {
        if (container != null) return
        val (screenW, screenH) = screenSize()
        val isLandscape = screenW > screenH
        val margin = dp(10f)
        val initW = dp(if (isLandscape) 356f else 340f)
        val initH = dp(if (isLandscape) 196f else 228f)
        val initial = OverlayBoundsMath.clampExpanded(
            x = (screenW - initW) / 2,
            y = dp(if (isLandscape) 24f else 68f),
            width = initW,
            height = initH,
            screenW = screenW,
            screenH = screenH,
            minW = dp(260f),
            minH = dp(168f),
            marginPx = margin,
        )
        savedExpandedX = initial.x
        savedExpandedY = initial.y
        savedExpandedW = initial.width
        savedExpandedH = initial.height

        val params = WindowManager.LayoutParams(
            initial.width,
            initial.height,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = initial.x
            y = initial.y
            softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
        }

        val root = object : FrameLayout(context) {
            override fun onTouchEvent(event: MotionEvent?): Boolean {
                if (event?.action == MotionEvent.ACTION_OUTSIDE && this@FloatingOverlayController.focusable) {
                    applyFocusableOnMain(false)
                }
                return super.onTouchEvent(event)
            }
        }.apply {
            setBackgroundColor(Color.TRANSPARENT)
        }

        val wv = WebView(context).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            setBackgroundColor(Color.TRANSPARENT)
            isFocusable = true
            isFocusableInTouchMode = true
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = false
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                cacheMode = WebSettings.LOAD_DEFAULT
                textZoom = 100
            }
            addJavascriptInterface(OverlayJsBridge(), "ZhilingOverlay")
            webViewClient = WebViewClient()
            loadUrl("http://127.0.0.1:$port/?mode=mini&platform=android&nativeOverlay=1")
        }

        root.addView(wv)
        try {
            windowManager.addView(root, params)
            container = root
            webView = wv
            layoutParams = params
            showing = true
        } catch (_: Throwable) {
            runCatching { wv.destroy() }
            showing = false
        }
    }

    private fun detachOverlayOnMain() {
        stopSpringOnMain()
        val root = container
        val wv = webView
        container = null
        webView = null
        layoutParams = null
        if (root != null) {
            runCatching { windowManager.removeViewImmediate(root) }
        }
        if (wv != null) {
            runCatching { wv.destroy() }
        }
    }

    private fun updateWindowLayoutSafe() {
        val root = container ?: return
        val params = layoutParams ?: return
        runCatching { windowManager.updateViewLayout(root, params) }
    }

    private fun clampLayoutToCurrentDisplay() {
        stopSpringOnMain()
        val params = layoutParams ?: return
        val (screenW, screenH) = screenSize()
        val margin = dp(10f)
        if (collapsed) {
            val bubbleW = dp(96f)
            val bubbleH = dp(44f)
            params.width = bubbleW
            params.height = bubbleH
            params.x = OverlayBoundsMath.snapBubbleX(params.x + bubbleW / 2, screenW, bubbleW, margin)
            params.y = params.y.coerceIn(dp(24f), (screenH - bubbleH - margin).coerceAtLeast(dp(24f)))
        } else {
            val clamped = OverlayBoundsMath.clampExpanded(
                x = params.x,
                y = params.y,
                width = params.width,
                height = params.height,
                screenW = screenW,
                screenH = screenH,
                minW = dp(260f),
                minH = dp(168f),
                marginPx = margin,
            )
            params.x = clamped.x
            params.y = clamped.y
            params.width = clamped.width
            params.height = clamped.height
            savedExpandedX = clamped.x
            savedExpandedY = clamped.y
            savedExpandedW = clamped.width
            savedExpandedH = clamped.height
        }
        updateWindowLayoutSafe()
    }

    private fun applyFocusableOnMain(nextFocusable: Boolean) {
        val params = layoutParams ?: return
        if (focusable == nextFocusable) return
        focusable = nextFocusable
        params.flags = if (nextFocusable) {
            (params.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv()) or
                WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
        } else {
            params.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
        }
        updateWindowLayoutSafe()
        if (nextFocusable) {
            webView?.requestFocus()
        }
    }

    private inner class OverlayJsBridge {
        @JavascriptInterface
        fun moveBy(dxCssPx: Float, dyCssPx: Float) {
            mainHandler.post {
                stopSpringOnMain()
                val params = layoutParams ?: return@post
                val (screenW, screenH) = screenSize()
                val margin = dp(8f)
                val dx = (dxCssPx * density()).roundToInt()
                val dy = (dyCssPx * density()).roundToInt()
                params.x = (params.x + dx).coerceIn(margin, (screenW - params.width - margin).coerceAtLeast(margin))
                params.y = (params.y + dy).coerceIn(margin, (screenH - params.height - margin).coerceAtLeast(margin))
                if (!collapsed) {
                    savedExpandedX = params.x
                    savedExpandedY = params.y
                }
                updateWindowLayoutSafe()
            }
        }

        @JavascriptInterface
        fun snapBubbleToEdge() {
            mainHandler.post {
                if (!collapsed) return@post
                val params = layoutParams ?: return@post
                val (screenW, screenH) = screenSize()
                val margin = dp(10f)
                val bubbleW = params.width.takeIf { it > 0 } ?: dp(96f)
                val bubbleH = params.height.takeIf { it > 0 } ?: dp(44f)
                val targetBubbleX = OverlayBoundsMath.snapBubbleX(
                    centerX = params.x + bubbleW / 2,
                    screenW = screenW,
                    bubbleW = bubbleW,
                    marginPx = margin,
                )
                val targetBubbleY = params.y.coerceIn(dp(24f), (screenH - bubbleH - margin).coerceAtLeast(dp(24f)))
                animateLayoutToOnMain(targetBubbleX, targetBubbleY, bubbleW, bubbleH)
            }
        }

        @JavascriptInterface
        fun resizeBy(dwCssPx: Float, dhCssPx: Float) {
            mainHandler.post {
                if (collapsed) return@post
                stopSpringOnMain()
                val params = layoutParams ?: return@post
                val (screenW, screenH) = screenSize()
                val margin = dp(8f)
                val dw = (dwCssPx * density()).roundToInt()
                val dh = (dhCssPx * density()).roundToInt()
                val clamped = OverlayBoundsMath.clampExpanded(
                    x = params.x,
                    y = params.y,
                    width = params.width + dw,
                    height = params.height + dh,
                    screenW = screenW,
                    screenH = screenH,
                    minW = dp(260f),
                    minH = dp(168f),
                    marginPx = margin,
                )
                params.width = clamped.width
                params.height = clamped.height
                savedExpandedW = clamped.width
                savedExpandedH = clamped.height
                updateWindowLayoutSafe()
            }
        }

        @JavascriptInterface
        fun setCollapsed(nextCollapsed: Boolean) {
            mainHandler.post {
                val params = layoutParams ?: return@post
                if (collapsed == nextCollapsed) return@post
                val (screenW, screenH) = screenSize()
                val margin = dp(10f)
                collapsed = nextCollapsed
                if (nextCollapsed) {
                    savedExpandedX = params.x
                    savedExpandedY = params.y
                    savedExpandedW = params.width
                    savedExpandedH = params.height
                    applyFocusableOnMain(false)
                    val bubbleW = dp(96f)
                    val bubbleH = dp(44f)
                    val destX = OverlayBoundsMath.snapBubbleX(
                        centerX = savedExpandedX + savedExpandedW / 2,
                        screenW = screenW,
                        bubbleW = bubbleW,
                        marginPx = margin,
                    )
                    val destY = savedExpandedY.coerceIn(dp(24f), (screenH - bubbleH - margin).coerceAtLeast(dp(24f)))
                    animateLayoutToOnMain(destX, destY, bubbleW, bubbleH)
                } else {
                    val bubbleW = params.width.takeIf { it > 0 } ?: dp(96f)
                    val clamped = OverlayBoundsMath.expandFromBubble(
                        bubbleX = params.x,
                        bubbleY = params.y,
                        bubbleW = bubbleW,
                        targetW = savedExpandedW.takeIf { it > 0 } ?: dp(340f),
                        targetH = savedExpandedH.takeIf { it > 0 } ?: dp(228f),
                        screenW = screenW,
                        screenH = screenH,
                        minW = dp(260f),
                        minH = dp(168f),
                        marginPx = margin,
                    )
                    savedExpandedX = clamped.x
                    savedExpandedY = clamped.y
                    savedExpandedW = clamped.width
                    savedExpandedH = clamped.height
                    animateLayoutToOnMain(clamped.x, clamped.y, clamped.width, clamped.height)
                }
            }
        }

        @JavascriptInterface
        fun setFocusable(nextFocusable: Boolean) {
            mainHandler.post { applyFocusableOnMain(nextFocusable) }
        }

        @JavascriptInterface
        fun setAiExpanded(expanded: Boolean) {
            mainHandler.post {
                if (collapsed) return@post
                val params = layoutParams ?: return@post
                if (aiExpanded == expanded) return@post
                aiExpanded = expanded
                val (screenW, screenH) = screenSize()
                val isLandscape = screenW > screenH
                val margin = dp(10f)
                val nextTargetH = if (expanded) {
                    preAiHeightPx = params.height
                    minOf(dp(if (isLandscape) 310f else 410f), (screenH * 0.84f).roundToInt())
                } else {
                    preAiHeightPx.takeIf { it > 0 } ?: dp(if (isLandscape) 196f else 228f)
                }
                val clamped = OverlayBoundsMath.clampExpanded(
                    x = params.x,
                    y = params.y,
                    width = params.width,
                    height = nextTargetH,
                    screenW = screenW,
                    screenH = screenH,
                    minW = dp(260f),
                    minH = dp(168f),
                    marginPx = margin,
                )
                savedExpandedY = clamped.y
                savedExpandedH = clamped.height
                animateLayoutToOnMain(clamped.x, clamped.y, clamped.width, clamped.height)
            }
        }

        @JavascriptInterface
        fun closeOverlay() {
            hide()
        }

        @JavascriptInterface
        fun openMainApp() {
            val intent = Intent(context, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            }
            runCatching { context.startActivity(intent) }
        }
    }
}
