/**
 * 手机号登录页（对应 `docs/design/login-light.html` / `login-dark.html`）。
 *
 * 流程与官方一致，四步：
 *   1. 填手机号 → 点「获取验证码」→ 自动弹出第一道滑块（sceneType=SMS）
 *   2. 滑块通过 → 才真正下发短信，页面切到验证码输入态并开始 60s 倒计时
 *   3. 填 4 位验证码 → 校验通过 → 自动弹出第二道滑块（sceneType=LGN）
 *   4. 第二道滑块通过 → 换 token → 进主界面
 *
 * 两道滑块都是**弹层**，不是常驻在页面上的控件：官方就是这么做的，而且常驻会
 * 让易盾 SDK 在用户还没到那一步时就先采集一次指纹。
 */
import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { LoginFlow } from '@xpeng/protocol/src/session';
import { sessionStore } from '../../core/session';
import { CaptchaModal } from '../SliderCaptcha';
import { Icon } from '../icons';
import { SpinnerIcon } from '../atoms';
import { useThemeMode } from '../../core/theme';

/** 与桌面图标同一张图（官方图标灰度反相），避免应用内外两个标志。 */
const BRAND_ICON = require('../../assets/brand/icon.png');

/** 官方短信验证码是 4 位（实测收到的短信如此），不是常见的 6 位。 */
const SMS_CODE_LEN = 4;

type Stage = 'phone' | 'code';

export function LoginScreen() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<Stage>('phone');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  /** 正在进行的网络动作；null 表示空闲。用于给按钮和状态行显示具体进度。 */
  const [pending, setPending] = useState<null | 'sending' | 'verifying' | 'signing'>(null);
  const busy = pending !== null;
  /**
   * 倒计时用「截止时间戳」而不是「剩余秒数」。
   *
   * 之前存剩余秒数、每渲染一次重建一个 1s 的 setTimeout：只要中途有别的 setState
   * （`pending`、`message`、`error` 任意一个变化）就会触发重渲染，旧 effect 被
   * cleanup 掉，新 effect 从同一个剩余值重新起跳——一旦某次渲染密集发生，链条就
   * 停在最后那个数字上不动（实测停在 1s）。存时间戳则与渲染次数无关，任何时刻
   * 都能算出真实的剩余值。
   */
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const countdown = cooldownUntil > now ? Math.ceil((cooldownUntil - now) / 1000) : 0;
  /** 当前该弹哪道滑块：发码那道（SMS）还是换 token 那道（LGN）。 */
  const [captcha, setCaptcha] = useState<'sms' | 'login' | null>(null);
  const flow = useRef<LoginFlow | null>(null);
  const [, , scheme] = useThemeMode();

  // 只有真的在倒计时时才挂心跳；归零后自动停，不空转。
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [cooldownUntil]);

  const phoneReady = phone.length === 11;

  /** 点「获取验证码」：先弹滑块，票据到手才发码。 */
  function requestCode() {
    if (!phoneReady) {
      setError('请先填写 11 位手机号');
      return;
    }
    setError('');
    setMessage('');
    setCaptcha('sms');
  }

  /** 第一道滑块通过：拿票据去换一次真实下发短信的机会。 */
  async function onSmsSlider(validate: string) {
    setCaptcha(null);
    setPending('sending');
    // 上一次拖错留下的提示必须清掉，否则重试成功后页面上还挂着红字
    setError('');
    setMessage('');
    try {
      flow.current = new LoginFlow(sessionStore.api, sessionStore.deviceId);
      const step = await flow.current.startWithSlider(validate, phone);
      setStage('code');
      setCooldownUntil(Date.now() + 60_000);
      setNow(Date.now());
      setMessage(step.message ?? '验证码已发送');
    } catch (e) {
      setError(describe(e));
    } finally {
      setPending(null);
    }
  }

  /** 验证码填满即自动提交，校验通过后立刻弹第二道滑块。 */
  async function submitCode(value: string) {
    if (!flow.current || busy) return;
    setPending('verifying');
    setError('');
    try {
      await flow.current.submitCode(value);
      setMessage('验证码通过');
      setCaptcha('login');
    } catch (e) {
      setError(describe(e));
    } finally {
      setPending(null);
    }
  }

  /** 第二道滑块通过：换 token 并落到会话存储，App 外壳会自动切到主界面。 */
  async function onLoginSlider(validate: string) {
    setCaptcha(null);
    if (!flow.current) return;
    setPending('signing');
    setError('');
    setMessage('');
    try {
      const session = await flow.current.finishWithSlider(validate);
      await sessionStore.adopt(session);
      // 成功后不需要清 pending：外壳已切走，这个页面马上卸载
    } catch (e) {
      setError(describe(e));
      setPending(null);
    }
  }

  function onChangePhone(next: string) {
    setPhone(next);
    setError('');
    // 改号等于换一个会话：旧的 xid 与倒计时都作废
    if (next !== phone) {
      setCooldownUntil(0);
      setStage('phone');
      setCode('');
      flow.current = null;
    }
  }

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-6 pt-2 pb-6 flex-grow"
        keyboardShouldPersistTaps="handled">
        {/* 顶部装饰线：设计稿里横贯页面的琥珀渐变 */}
        <View className="h-1 -mx-6 mb-4 bg-primary-container/40" />

        {/* 品牌区：左图标右两行文字，不是居中的大标题 */}
        <View className="flex-row items-center gap-3.5 mt-2 mb-7">
          <View className="w-12 h-12 rounded-xl bg-surface border border-outline-variant items-center justify-center overflow-hidden">
            <View className="absolute top-0 right-0 w-8 h-1 bg-primary-container" />
            <Image source={BRAND_ICON} className="w-8 h-8 rounded-lg" resizeMode="contain" />
          </View>
          <View className="flex-col">
            <View className="flex-row items-center gap-2">
              <Text className="font-headline font-black text-[23px] tracking-tight text-on-surface">
                小鹏友
              </Text>
              <View className="px-1.5 py-0.5 bg-primary-container/10 border border-primary-container/30 rounded">
                <Text className="font-mono text-[9px] font-bold text-primary tracking-wider">
                  TELEMATICS
                </Text>
              </View>
            </View>
            <View className="mt-1 flex-row items-center gap-1.5">
              <View className="w-1.5 h-1.5 rounded-full bg-secondary-fixed-dim" />
              <Text className="font-body text-[12px] font-medium text-on-surface-variant">
                非官方自研客户端
              </Text>
            </View>
          </View>
        </View>

        {/* 表单卡片 */}
        <View className="bg-surface rounded-2xl border border-outline-variant/80 p-5 overflow-hidden">
          <View className="absolute top-0 left-5 right-5 h-[1.5px] bg-primary-container/25" />

          {/* 手机号 */}
          <View className="mb-4">
            <View className="flex-row items-center justify-between mb-1.5">
              <Text className="font-body text-[13px] font-semibold text-on-surface-variant">
                手机号
              </Text>
              <Text className="font-mono text-[10px] text-outline font-medium">CHN MOBILE</Text>
            </View>
            <View className="w-full h-12 bg-surface-container-low rounded-xl border border-outline-variant flex-row items-center px-3.5">
              <View className="flex-row items-center pr-2.5 mr-2.5 border-r border-outline-variant/80">
                <Text className="font-mono text-[14px] font-bold text-primary">+86</Text>
                <Text className="font-icon text-[16px] text-outline ml-1">{Icon.expand_more}</Text>
              </View>
              <TextInput
                value={phone}
                onChangeText={onChangePhone}
                editable={stage === 'phone' && !busy}
                keyboardType="phone-pad"
                maxLength={11}
                placeholder="请输入 11 位手机号"
                placeholderTextColor="#8A7F68"
                className="flex-1 font-mono text-[15px] text-on-surface p-0"
              />
            </View>
          </View>

          {/* 验证码：发码后才出现，与设计稿的「一步一屏」一致 */}
          {stage === 'code' ? (
            <View className="mb-4">
              <View className="flex-row items-center justify-between mb-1.5">
                <Text className="font-body text-[13px] font-semibold text-on-surface-variant">
                  验证码
                </Text>
                <Text className="font-mono text-[10px] text-outline font-medium">ONE-TIME CODE</Text>
              </View>
              <View className="w-full h-12 bg-surface-container-low rounded-xl border border-outline-variant flex-row items-center pl-3.5 pr-1.5">
                <TextInput
                  value={code}
                  onChangeText={(v) => {
                    setCode(v);
                    setError('');
                    if (v.length === SMS_CODE_LEN) submitCode(v);
                  }}
                  editable={!busy}
                  autoFocus
                  keyboardType="number-pad"
                  maxLength={SMS_CODE_LEN}
                  placeholder={`请输入 ${SMS_CODE_LEN} 位验证码`}
                  placeholderTextColor="#8A7F68"
                  className="flex-1 font-mono text-[15px] text-on-surface p-0 tracking-widest"
                />
                <Pressable
                  onPress={countdown > 0 || busy ? undefined : requestCode}
                  className="h-9 px-3 rounded-lg bg-surface border border-primary-container/40 items-center justify-center"
                  style={{ opacity: countdown > 0 ? 0.5 : 1 }}>
                  <Text className="font-body text-[12px] font-semibold text-primary">
                    {pending === 'sending'
                      ? '发送中…'
                      : countdown > 0
                        ? `${countdown}s 后重试`
                        : '获取验证码'}
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          <View className="pt-2 gap-3">
            {stage === 'code' ? (
              <Pressable
                onPress={() => submitCode(code)}
                disabled={busy || code.length !== SMS_CODE_LEN}
                className="w-full h-12 rounded-xl items-center justify-center flex-row gap-2 bg-primary"
                style={{ opacity: busy || code.length !== SMS_CODE_LEN ? 0.5 : 1 }}>
                <Text className="font-headline font-extrabold text-[16px] tracking-wider text-on-primary uppercase">
                  {pending === 'verifying'
                    ? '校验验证码…'
                    : pending === 'signing'
                      ? '正在登录…'
                      : '登录'}
                </Text>
                {busy ? (
                  <SpinnerIcon size={19} className="text-on-primary" />
                ) : (
                  <Text className="font-icon text-[19px] text-on-primary">{Icon.expand_more}</Text>
                )}
              </Pressable>
            ) : (
              <Pressable
                onPress={busy ? undefined : requestCode}
                className="w-full h-12 rounded-xl bg-primary items-center justify-center flex-row gap-2 active:scale-[0.98]">
                <Text className="font-headline font-extrabold text-[16px] tracking-wider text-on-primary uppercase">
                  {pending === 'sending' ? '正在发送…' : '获取验证码'}
                </Text>
                {pending === 'sending' ? (
                  <SpinnerIcon size={19} className="text-on-primary" />
                ) : (
                  <Text className="font-icon text-[19px] text-on-primary">{Icon.expand_more}</Text>
                )}
              </Pressable>
            )}

            <Pressable
              onPress={() => {
                if (stage === 'code') {
                  setStage('phone');
                  setCode('');
                  setCooldownUntil(0);
                  flow.current = null;
                }
                setMessage('');
                setError('');
              }}
              className="w-full h-11 rounded-xl bg-surface-container/70 border border-outline-variant/90 items-center justify-center flex-row gap-2 active:scale-[0.98]">
              <Text className="font-icon text-[18px] text-secondary-fixed-dim">{Icon.lock}</Text>
              <Text className="font-body text-[13px] font-semibold text-on-surface-variant">
                {stage === 'code' ? '换一个手机号' : '使用已保存的令牌登录'}
              </Text>
            </Pressable>
          </View>

          {/* 状态行：设计稿没有，但流程需要；左对齐贴在卡片里，不用居中 Banner */}
          {pending ? (
            <View className="mt-3 flex-row items-center gap-1.5">
              <SpinnerIcon size={14} className="text-secondary-fixed-dim" />
              <Text className="font-body text-[12px] text-on-surface-variant flex-shrink">
                {pending === 'sending'
                  ? '正在发送验证码，请稍候…'
                  : pending === 'verifying'
                    ? '正在校验验证码…'
                    : '正在换取登录凭证…'}
              </Text>
            </View>
          ) : null}
          {message ? (
            <View className="mt-3 flex-row items-center gap-1.5">
              <Text className="font-icon text-[14px] text-secondary-fixed-dim">
                {Icon.check_circle}
              </Text>
              <Text className="font-body text-[12px] text-on-surface-variant flex-shrink">
                {message}
              </Text>
            </View>
          ) : null}
          {error ? (
            <View className="mt-3 flex-row items-center gap-1.5">
              <Text className="font-icon text-[14px] text-error">{Icon.gpp_bad}</Text>
              <Text className="font-body text-[12px] text-error flex-shrink">{error}</Text>
            </View>
          ) : null}
        </View>

        {/* 页脚：合规说明胶囊 */}
        <View className="items-center pt-4 pb-2 mt-auto">
          <View className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-container/80 border border-outline-variant/60">
            <Text className="font-icon text-[15px] text-secondary-fixed-dim">{Icon.shield}</Text>
            <Text className="font-body text-[11px] text-on-surface-variant font-medium">
              仅使用本人账号，不收集第三方数据
            </Text>
          </View>
        </View>
      </ScrollView>

      <CaptchaModal
        visible={captcha !== null}
        scheme={scheme}
        onValidated={captcha === 'sms' ? onSmsSlider : onLoginSlider}
        // 拖错不关弹层：关掉再让用户自己找按钮重来，等于把一次可恢复的失败变成
        // 死路。原地把错误显示在页面上，用户直接再拖一次即可（弹层内 WebView 已
        // 按代次重建，旧的作废实例不会干扰）。
        //
        // 这里不把易盾原文（`300(unpass error) - Failed to verify captcha`）抛给
        // 用户：那是英文内部错误码，对「再拖一次」这个动作没有指导意义。
        onError={() => setError('滑块验证未通过，请再拖一次')}
        onCancel={() => setCaptcha(null)}
      />
    </View>
  );
}

/** 把协议层抛出的错误压成一句人话；原文可能是 `12040101 需要滑块验证` 这种。 */
function describe(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/票据只能用一次|未通过/.test(raw)) return '滑块验证未通过，请重新获取验证码再试';
  if (/12040102/.test(raw)) return '验证码不正确或已过期';
  if (/网络|timeout|Failed to fetch|socket/i.test(raw)) return '网络异常，请检查连接后重试';
  return raw;
}
