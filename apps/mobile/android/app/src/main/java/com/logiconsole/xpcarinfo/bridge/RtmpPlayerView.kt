package com.logiconsole.xpcarinfo.bridge

import android.annotation.SuppressLint
import android.widget.FrameLayout
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.datasource.rtmp.RtmpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

/**
 * 远程查看的实时画面播放器。
 *
 * 车端开流的回执里给的是 RTMP 地址（`rtmp://live.xiaopeng.com/...?auth_key=...`，
 * 见 docs/research/xpeng-app-teardown.md §5.7）。Media3 的默认数据源不认识 rtmp
 * scheme，因此整条链路只挂 [RtmpDataSource]：这里只可能播 RTMP，不需要回退。
 *
 * `auth_key` 是每次开流现签的时效凭据，地址只从当次回执取、不可缓存，所以
 * `streamUrl` 变化（切视角、重开流）就整条重建播放；置空即关流。
 */
@SuppressLint("ViewConstructor")
class RtmpPlayerView(context: ThemedReactContext) : FrameLayout(context) {

    private val exoPlayer: ExoPlayer = ExoPlayer.Builder(context)
        .setMediaSourceFactory(DefaultMediaSourceFactory(RtmpDataSource.Factory()))
        .build()

    private val playerView: PlayerView = PlayerView(context).apply {
        player = exoPlayer
        useController = false
        resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
    }

    init {
        addView(playerView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }

    fun setStreamUrl(url: String?) {
        if (url.isNullOrEmpty()) {
            exoPlayer.stop()
            exoPlayer.clearMediaItems()
            return
        }
        exoPlayer.setMediaItem(MediaItem.fromUri(url))
        exoPlayer.prepare()
        exoPlayer.playWhenReady = true
    }

    /** 播放器持有解码器与 Surface，必须在 View 被丢弃时显式释放，否则会泄漏并占住解码器。 */
    fun release() {
        exoPlayer.release()
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        exoPlayer.pause()
    }
}

class RtmpPlayerViewManager : SimpleViewManager<RtmpPlayerView>() {
    override fun getName() = "RtmpPlayerView"

    override fun createViewInstance(ctx: ThemedReactContext) = RtmpPlayerView(ctx)

    @ReactProp(name = "streamUrl")
    fun setStreamUrl(view: RtmpPlayerView, url: String?) {
        view.setStreamUrl(url)
    }

    override fun onDropViewInstance(view: RtmpPlayerView) {
        view.release()
        super.onDropViewInstance(view)
    }
}
