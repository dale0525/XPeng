/**
 * 易盾滑块。WebView 装 SDK 页面，真人拖完把 `validate` 票据回传。
 *
 * 票据一次性、约 2 分钟过期；`validate` 只能被服务端消费一次，所以拿到就立刻
 * 交给调用方，不缓存。
 */
import { useMemo, useRef } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { requireNativeComponent, type NativeSyntheticEvent } from 'react-native';
import { CAPTCHA_ID } from '@xpeng/protocol/src/config';
import { themeVars } from '../core/theme';

interface ChangeEvent {
  type: 'validate' | 'error' | 'ready';
  value: string;
}

const CaptchaWebView = requireNativeComponent<{
  html: string;
  style?: { flex: number };
  onChange?: (e: NativeSyntheticEvent<ChangeEvent>) => void;
}>('CaptchaWebView');

/**
 * 页面脚本。`initNECaptcha` 是易盾 SDK 的全局入口，回调签名见
 * `scripts/login-ui.py` 里已经验证过的那份——同样的参数在这里重放。
 */
function captchaHtml(captchaId: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>
  html,body{margin:0;padding:0;background:transparent;
    font:14px/1.5 -apple-system,"PingFang SC",sans-serif;color:#3f4850}
  #wrap{padding:12px 0}
  #cap{min-height:44px;border-radius:8px;background:#f1f3ff;border:1px solid #bfc7d2;
    display:flex;align-items:center;justify-content:center;color:#707881;font-size:13px}
  #msg{margin-top:8px;font-size:12px;color:#707881}
</style>
<script src="https://cstaticdun.126.net/load.min.js"></script>
</head><body>
<div id="wrap"><div id="cap">正在加载安全验证…</div><div id="msg"></div></div>
<script>
  var msg = function (t) { document.getElementById('msg').textContent = t; };
  window.onerror = function (m) { XpengBridge.onError(String(m)); };

  function boot() {
    if (typeof initNECaptcha !== 'function') { setTimeout(boot, 200); return; }
    initNECaptcha({
      captchaId: ${JSON.stringify(captchaId)},
      element: '#cap',
      // embed 直接嵌在页面里；popup 还要用户再点一次才弹层
      mode: 'embed',
      width: '100%',
      onVerify: function (err, data) {
        if (err) { XpengBridge.onError((err && err.message) || '滑块出错'); return; }
        XpengBridge.onValidate(data.validate);
      }
    }, function (instance) {
      window.__cap = instance;
      XpengBridge.onReady();
      // SDK 会自己接管 #cap 的渲染，这里不再改文案
    });
  }
  boot();
</script>
</body></html>`;
}

export function SliderCaptcha({
  disabled,
  onValidated,
  onError,
}: {
  disabled?: boolean;
  onValidated: (validate: string) => void;
  onError?: (message: string) => void;
}) {
  const html = useMemo(() => captchaHtml(CAPTCHA_ID), []);
  const settled = useRef(false);

  return (
    <View
      className="rounded-lg border border-outline-variant/50 overflow-hidden bg-surface-container-low"
      style={{ height: 180, opacity: disabled ? 0.5 : 1 }}>
      <CaptchaWebView
        style={{ flex: 1 }}
        html={html}
        onChange={(e) => {
          const { type, value } = e.nativeEvent;
          if (type === 'validate' && !settled.current) {
            settled.current = true;
            onValidated(value);
          } else if (type === 'error') {
            onError?.(value);
          }
        }}
      />
      <Text className="text-[11px] text-outline text-center py-1">向右拖动滑块完成验证</Text>
    </View>
  );
}

/**
 * 弹层版滑块：与官方一致——用户点「获取验证码」后自动弹出，拖完即关。
 *
 * 每次打开都要重建 WebView（`key` 随 visible 变），因为易盾的 `validate` 票据
 * 一次性且 SDK 实例拖过一次就作废；复用同一个 WebView 会让第二次拖动的票据失效。
 */
export function CaptchaModal({
  visible,
  scheme,
  onValidated,
  onError,
  onCancel,
}: {
  visible: boolean;
  scheme: 'light' | 'dark';
  onValidated: (validate: string) => void;
  onError: (message: string) => void;
  onCancel: () => void;
}) {
  // Modal 渲染在独立根节点上，拿不到页面根节点的 --c-* 变量，必须自己注入
  const themed = themeVars(scheme);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={themed} className="flex-1 bg-black/50 items-center justify-center px-6">
        <View className="w-full bg-surface rounded-2xl border border-outline-variant/40 p-4">
          <View className="flex-row items-center justify-between mb-3">
            <Text className="font-headline font-bold text-sm text-on-surface">安全验证</Text>
            <Pressable onPress={onCancel} hitSlop={12} className="active:scale-95">
              <Text className="text-[13px] text-on-surface-variant">取消</Text>
            </Pressable>
          </View>
          <SliderCaptcha key={String(visible)} onValidated={onValidated} onError={onError} />
        </View>
      </View>
    </Modal>
  );
}
