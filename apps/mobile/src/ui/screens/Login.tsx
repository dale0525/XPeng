/**
 * 手机号登录页（对应 `docs/design/c6048d2d97a84497b5ed3c70524e44ff.html`，亮色基准）。
 *
 * 两道滑块都是弹层而非常驻控件：官方就是这么做的，而且常驻会让易盾 SDK 在用户
 * 还没到那一步时就先采集一次指纹。稿中的「请验证滑块」胶囊因此只作状态提示。
 */
import { useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import { Pressable, ScrollView, Text, TextInput, View, type TextInputInstance } from 'react-native';
import { LoginFlow } from '@xpeng/protocol/src/session';
import { DARK_COLORS, LIGHT_COLORS } from '../../core/colors';
import { sessionStore } from '../../core/session';
import { useThemeMode } from '../../core/theme';
import { plateShadow, SpinnerIcon } from '../atoms';
import { CapsTag } from '../components';
import { Icon } from '../icons';
import { CaptchaModal } from '../SliderCaptcha';

/** 官方短信验证码是 4 位（实测收到的短信如此），不是常见的 6 位。 */
const SMS_CODE_LEN = 4;
const RESEND_LABEL = '60s 后重发';

type Stage = 'phone' | 'code';

export function LoginScreen(): React.JSX.Element {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<Stage>('phone');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<null | 'sending' | 'verifying' | 'signing'>(null);
  const busy = pending !== null;
  /**
   * 倒计时存截止时间戳而不是剩余秒数：存秒数时每渲染一次就重建 1s 定时器，
   * 中途任何 setState 都会让旧 effect 被 cleanup，链条会停在同一数字上不动
   * （实测停在 1s）。存时间戳则与渲染次数无关。
   */
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const countdown = cooldownUntil > now ? Math.ceil((cooldownUntil - now) / 1000) : 0;
  const [captcha, setCaptcha] = useState<'sms' | 'login' | null>(null);
  const flow = useRef<LoginFlow | null>(null);
  const codeInput = useRef<TextInputInstance>(null);
  const [, , scheme] = useThemeMode();
  const placeholderColor = (scheme === 'dark' ? DARK_COLORS : LIGHT_COLORS)['on-surface-variant'];

  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [cooldownUntil]);

  useEffect(() => {
    if (stage === 'code') codeInput.current?.focus();
  }, [stage]);

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

  function resetCodeStage() {
    setStage('phone');
    setCode('');
    setCooldownUntil(0);
    flow.current = null;
    setMessage('');
    setError('');
  }

  function pressLogin() {
    if (busy) return;
    if (stage === 'code' && flow.current) {
      if (code.length === SMS_CODE_LEN) submitCode(code);
      else codeInput.current?.focus();
      return;
    }
    if (countdown > 0) return;
    requestCode();
  }

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-6 pt-5 pb-6 flex-grow"
        keyboardShouldPersistTaps="handled">
        <View className="flex-1 flex-col justify-between">
          {/* 顶部栏 + 标题 */}
          <View className="w-full flex-col">
            <View className="w-full h-11 flex-row items-center justify-between">
              <Pressable
                onPress={resetCodeStage}
                accessibilityLabel="返回"
                className="w-11 h-11 rounded-full bg-surface items-center justify-center active:scale-95"
                style={plateShadow}>
                <Text className="font-icon text-[20px] text-on-surface">{Icon.arrow_back}</Text>
              </Pressable>
            </View>
            <View className="mt-8 mb-2">
              <Text className="font-headline text-[32px] font-bold leading-tight tracking-tight text-on-surface">
                手机号登录
              </Text>
              <Text className="mt-2 font-body text-[14px] text-on-surface-variant font-normal">
                使用手机号验证码登录
              </Text>
            </View>
          </View>

          {/* 表单区 */}
          <View className="w-full py-2 my-auto">
            <View className="w-full gap-3.5">
              {/* 手机号胶囊 */}
              <View
                className="w-full h-[62px] rounded-full bg-surface border border-surface-container px-5 flex-row items-center"
                style={plateShadow}>
                <View className="flex-row items-center gap-1 pr-3 border-r border-surface-variant">
                  <Text className="font-headline text-[15px] font-semibold text-on-surface">+86</Text>
                  <Text className="font-icon text-[18px] text-on-surface-variant">
                    {Icon.expand_more}
                  </Text>
                </View>
                <TextInput
                  value={phone}
                  onChangeText={onChangePhone}
                  editable={stage === 'phone' && !busy}
                  keyboardType="phone-pad"
                  maxLength={11}
                  placeholder="请输入 11 位手机号"
                  placeholderTextColor={placeholderColor}
                  className="flex-1 ml-4 font-body text-[15px] text-on-surface p-0"
                />
              </View>

              {/* 验证码胶囊 */}
              <View
                className="w-full h-[62px] rounded-full bg-surface border border-surface-container pl-5 pr-2.5 flex-row items-center justify-between"
                style={plateShadow}>
                <TextInput
                  ref={codeInput}
                  value={code}
                  onChangeText={(v) => {
                    setCode(v);
                    setError('');
                    if (v.length === SMS_CODE_LEN) submitCode(v);
                  }}
                  editable={stage === 'code' && !busy}
                  keyboardType="number-pad"
                  maxLength={SMS_CODE_LEN}
                  placeholder="请输入 4 位验证码"
                  placeholderTextColor={placeholderColor}
                  className="flex-1 font-body text-[15px] text-on-surface p-0"
                />
                <View className="flex-row items-center gap-2 pl-2">
                  <View className="w-[1px] h-5 bg-surface-variant" />
                  <Pressable
                    onPress={countdown > 0 || busy ? undefined : requestCode}
                    className="px-1 py-1"
                    style={{ opacity: countdown > 0 || busy ? 0.5 : 1 }}>
                    <Text className="font-body text-[13px] font-semibold text-on-surface">
                      获取验证码
                    </Text>
                  </Pressable>
                  <View className="h-7 px-2.5 rounded-full bg-surface-variant items-center justify-center">
                    <CapsTag text={countdown > 0 ? `${countdown}s 后重发` : RESEND_LABEL} />
                  </View>
                </View>
              </View>

              {/* 滑块验证状态槽 */}
              <View
                className="w-full h-[52px] rounded-full bg-surface border border-surface-container px-4 flex-row items-center justify-between"
                style={plateShadow}>
                <View className="flex-row items-center gap-2.5">
                  <View className="w-6 h-6 rounded-full bg-primary-container items-center justify-center">
                    <Text className="font-icon text-[16px] text-on-surface">
                      {Icon.priority_high}
                    </Text>
                  </View>
                  <Text className="font-body text-[13px] font-medium text-on-surface">
                    请验证滑块
                  </Text>
                </View>
                <View className="flex-row items-center gap-2 pr-1">
                  <Text className="font-body text-[12px] text-on-surface-variant font-normal">
                    验证中
                  </Text>
                  {busy || captcha !== null ? (
                    <SpinnerIcon size={16} className="text-on-surface" />
                  ) : (
                    <View className="w-4 h-4 rounded-full border-2 border-surface-variant" />
                  )}
                </View>
              </View>

              {message ? (
                <View className="flex-row items-center gap-1.5">
                  <Text className="font-icon text-[14px] text-secondary-fixed-dim">
                    {Icon.check_circle}
                  </Text>
                  <Text className="font-body text-[12px] text-on-surface-variant flex-shrink">
                    {message}
                  </Text>
                </View>
              ) : null}
              {error ? (
                <View className="flex-row items-center gap-1.5">
                  <Text className="font-icon text-[14px] text-error">{Icon.gpp_bad}</Text>
                  <Text className="font-body text-[12px] text-error flex-shrink">{error}</Text>
                </View>
              ) : null}
            </View>
          </View>

          {/* 操作区 */}
          <View className="w-full flex-col items-center mt-2 mb-4">
            <Pressable
              onPress={pressLogin}
              disabled={busy}
              className="w-full h-[56px] rounded-full bg-primary-container items-center justify-center active:scale-[0.98]"
              style={{ opacity: busy ? 0.6 : 1 }}>
              <Text className="font-headline text-[16px] font-bold tracking-wide text-on-primary-fixed">
                登录
              </Text>
            </Pressable>
            <Pressable onPress={resetCodeStage} className="mt-4 active:scale-95">
              <Text className="font-body text-[13px] font-medium text-on-surface-variant">
                换一个手机号
              </Text>
            </Pressable>
          </View>

          {/* 底部安全说明 */}
          <View className="w-full flex-col items-center gap-2 pb-1">
            <View
              className="w-full max-w-[340px] rounded-full bg-surface py-2 px-3.5 flex-row items-center justify-center gap-1.5"
              style={plateShadow}>
              <Text className="font-icon text-[15px] text-on-surface-variant">
                {Icon.shield}
              </Text>
              <Text className="font-body text-[12px] leading-none tracking-tight text-on-surface-variant">
                仅使用本人账号，不收集第三方数据
              </Text>
            </View>
            <View
              className="w-full max-w-[340px] rounded-full bg-surface py-2 px-3.5 flex-row items-center justify-center gap-1.5"
              style={plateShadow}>
              <Text className="font-icon text-[15px] text-on-surface-variant">
                {Icon.info}
              </Text>
              <Text className="font-body text-[12px] leading-none tracking-tight text-on-surface-variant">
                登录会把官方 App 踢下线
              </Text>
            </View>
            <View className="pt-2 flex-row items-center gap-1.5">
              <View className="w-2 h-2 rounded-full bg-secondary-container" />
              <Text className="font-body text-[12px] font-medium text-on-surface-variant">
                服务连接正常
              </Text>
            </View>
          </View>
        </View>
      </ScrollView>

      <CaptchaModal
        visible={captcha !== null}
        scheme={scheme}
        onValidated={captcha === 'sms' ? onSmsSlider : onLoginSlider}
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
