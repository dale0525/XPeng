/**
 * RTMP 播放器的 JS 侧封装（原生 `RtmpPlayerView`，Media3 ExoPlayer，见同目录 Kotlin）。
 *
 * 只做一件事：把 `streamUrl` 交给原生播放。地址是车端开流回执里的
 * `camera_live_url`（RTMP，带时效签名），置空即停流。
 */
import { requireNativeComponent, type ViewProps } from 'react-native';

export const RtmpPlayer = requireNativeComponent<ViewProps & { streamUrl?: string }>(
  'RtmpPlayerView',
);
