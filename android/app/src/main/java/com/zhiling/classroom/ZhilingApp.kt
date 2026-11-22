package com.zhiling.classroom

import android.app.Application

class ZhilingApp : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    companion object {
        @Volatile
        lateinit var instance: ZhilingApp
            private set
    }
}
