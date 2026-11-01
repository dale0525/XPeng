/**
 * 手机号登录页（对应 `docs/design/login-light.html` / `login-dark.html`）。
 *
 * 流程与官方一致，四步：
 *   1. 填手机号 → 点「获取验证码」→ 自动弹出第一道滑块（sceneType=SMS）
 *   2. 滑块通过 → 才真正下发短信，页面切到验证码输入态并开始 60s 倒计时
 *   3. 填 6 位验证码 → 校验通过 → 自动弹出第二道滑块（sceneType=LGN）
 *   4. 第二道滑块通过 → 换 token → 进主界面
 *
 * 两道滑块都是**弹层**，不是常驻在页面上的控件：官方就是这么做的，而且常驻会
 * 让易盾 SDK 在用户还没到那一步时就先采集一次指纹。
 */
import { useEffect, useRef, useState } from 'react';
import { Image, ScrollView, Text, TextInput, View } from 'react-native';
import { LoginFlow } from '@xpeng/protocol/src/session';
import { sessionStore } from '../../core/session';
import { Banner, PrimaryButton } from '../components';
import { CaptchaModal } from '../SliderCaptcha';
import type { ThemeMode } from '../../core/theme';
import { useThemeMode } from '../../core/theme';

/** 与桌面图标同一张图（官方图标灰度反相），避免应用内外两个标志。 */
const BRAND_ICON = require('../../assets/brand/icon.png');

type Stage = 'phone' | 'code';

export function LoginScreen() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<Stage>('phone');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState(0);
  /** 当前该弹哪道滑块：发码那道（SMS）还是换 token 那道（LGN）。 */
  const [captcha, setCaptcha] = useState<'sms' | 'login' | null>(null);
  const flow = useRef<LoginFlow | null>(null);
  const [, , scheme] = useThemeMode();

  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

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
    setBusy(true);
    try {
      flow.current = new LoginFlow(sessionStore.api, sessionStore.deviceId);
      const step = await flow.current.startWithSlider(validate, phone);
      setStage('code');
      setCountdown(60);
      setMessage(step.message ?? '验证码已发送');
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  /** 验证码填满即自动提交，校验通过后立刻弹第二道滑块。 */
  async function submitCode(value: string) {
    if (!flow.current || busy) return;
    setBusy(true);
    setError('');
    try {
      await flow.current.submitCode(value);
      setMessage('验证码通过');
      setCaptcha('login');
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  /** 第二道滑块通过：换 token 并落到会话存储，App 外壳会自动切到主界面。 */
  async function onLoginSlider(validate: string) {
    setCaptcha(null);
    if (!flow.current) return;
    setBusy(true);
    try {
      const session = await flow.current.finishWithSlider(validate);
      await sessionStore.adopt(session);
      // 成功后不需要 setBusy(false)：外壳已切走，这个页面马上卸载
    } catch (e) {
      setError(describe(e));
      setBusy(false);
    }
  }

  function onChangePhone(next: string) {
    setPhone(next);
    setError('');
    // 改号等于换一个会话：旧的 xid 与倒计时都作废
    if (next !== phone) {
      setCountdown(0);
      setStage('phone');
      setCode('');
      flow.current = null;
    }
  }

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-margin pt-space-xl pb-32"
        keyboardShouldPersistTaps="handled">
        <View className="items-center mb-space-xl">
          <Image
            source={BRAND_ICON}
            className="w-14 h-14 rounded-2xl mb-space-sm"
            resizeMode="contain"
          />
          <Text className="text-[28px] font-semibold text-on-surface tracking-tight">小鹏友</Text>
          <Text className="text-[14px] text-on-surface-variant mt-1">
            用手机号登录，登录一次后长期有效
          </Text>
        </View>

        <View className="bg-surface-container-lowest rounded-lg border border-outline-variant/30 p-space-md">
          <Text className="text-[11px] font-semibold tracking-wider text-outline mb-1">手机号</Text>
          <View className="flex-row items-center border-b border-outline-variant/60 pb-2">
            <TextInput
              value={phone}
              onChangeText={onChangePhone}
              editable={stage === 'phone' && !busy}
              keyboardType="phone-pad"
              maxLength={11}
              placeholder="请输入 11 位手机号"
              placeholderTextColor="#707881"
              className="flex-1 text-[16px] text-on-surface"
            />
            <View
              className={`px-2 py-1 rounded-full ${
                countdown > 0 ? 'bg-surface-container' : 'bg-secondary-fixed'
              }`}>
              <Text
                onPress={countdown > 0 || busy ? undefined : requestCode}
                className={`text-[11px] font-semibold ${
                  countdown > 0 ? 'text-outline' : 'text-on-secondary-fixed'
                }`}>
                {countdown > 0 ? `${countdown}s 后重试` : '获取验证码'}
              </Text>
            </View>
          </View>

          {stage === 'code' ? (
            <>
              <Text className="text-[11px] font-semibold tracking-wider text-outline mt-space-md mb-1">
                验证码
              </Text>
              <TextInput
                value={code}
                onChangeText={(v) => {
                  setCode(v);
                  setError('');
                  if (v.length === 6) submitCode(v);
                }}
                editable={!busy}
                autoFocus
                keyboardType="number-pad"
                maxLength={6}
                placeholder="请输入 6 位验证码"
                placeholderTextColor="#707881"
                className="border-b border-outline-variant/60 pb-2 text-[16px] text-on-surface tracking-[0.4em]"
              />
              <View className="mt-space-md">
                <PrimaryButton
                  label={busy ? '校验中…' : '登录'}
                  onPress={() => submitCode(code)}
                  disabled={busy || code.length !== 6}
                />
                <Text
                  onPress={() => {
                    setStage('phone');
                    setCode('');
                    setMessage('');
                    setError('');
                    setCountdown(0);
                    flow.current = null;
                  }}
                  className="text-center text-[13px] text-primary font-medium mt-space-sm">
                  换一个手机号
                </Text>
              </View>
            </>
          ) : null}

          {message ? (
            <View className="mt-space-md">
              <Banner text={message} tone="info" />
            </View>
          ) : null}

          {error ? (
            <View className="mt-space-md">
              <Banner text={error} tone="error" />
            </View>
          ) : null}
        </View>

        <Text className="text-[12px] text-outline text-center mt-space-lg leading-relaxed">
          登录会把官方 App 踢下线，两者不能同时在线。
        </Text>
      </ScrollView>

      <CaptchaModal
        visible={captcha !== null}
        scheme={scheme}
        onValidated={captcha === 'sms' ? onSmsSlider : onLoginSlider}
        onError={(m) => {
          setCaptcha(null);
          setError(m);
        }}
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
