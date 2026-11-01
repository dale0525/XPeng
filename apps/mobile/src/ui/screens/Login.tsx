/**
 * 手机号登录页（对应 `docs/design/f89ec92ec0f34ae1b343ef454bdca42f.html`）。
 *
 * 两步滑块是这个 App 最反直觉的地方：发码前拖一次（sceneType=SMS），拿到短信码
 * 之后还要再拖一次（sceneType=LGN）才能换到 token。所以页面上有两个滑块位，第二个
 * 在验证码通过后才出现——与设计稿一致。
 */
import { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { LoginFlow } from '@xpeng/protocol/src/session';
import { sessionStore } from '../../core/session';
import { Banner, PrimaryButton } from '../components';
import { Icon } from '../icons';
import { SliderCaptcha } from '../SliderCaptcha';

type Stage = 'phone' | 'code' | 'second-slider';

export function LoginScreen() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<Stage>('phone');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const flow = useRef<LoginFlow | null>(null);

  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  /** 第一道滑块通过：拿票据去换一次真实下发短信的机会。 */
  async function onFirstSlider(validate: string) {
    if (phone.length !== 11) {
      setMessage('请先填写 11 位手机号');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      flow.current = new LoginFlow(sessionStore.api, sessionStore.deviceId);
      const step = await flow.current.startWithSlider(validate, phone);
      setStage('code');
      setCountdown(60);
      setMessage(step.message ?? '验证码已发送');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode() {
    if (!flow.current || code.length !== 6) return;
    setBusy(true);
    try {
      const step = await flow.current.submitCode(code);
      setStage('second-slider');
      setMessage(step.message ?? '');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** 第二道滑块通过：换 token 并落到会话存储。 */
  async function onSecondSlider(validate: string) {
    if (!flow.current) return;
    setBusy(true);
    try {
      const session = await flow.current.finishWithSlider(validate);
      await sessionStore.adopt(session);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-margin pt-space-xl pb-32"
        keyboardShouldPersistTaps="handled">
        <View className="items-center mb-space-xl">
          <View className="w-14 h-14 rounded-2xl bg-primary items-center justify-center mb-space-sm">
            <Text className="text-on-primary text-[28px] font-icon">{Icon.directions_car}</Text>
          </View>
          <Text className="text-[28px] font-semibold text-on-surface tracking-tight">小鹏车控</Text>
          <Text className="text-[14px] text-on-surface-variant mt-1">
            用手机号登录，登录一次后长期有效
          </Text>
        </View>

        <View className="bg-surface-container-lowest rounded-lg border border-outline-variant/30 p-space-md">
          <Text className="text-[11px] font-semibold tracking-wider text-outline mb-1">手机号</Text>
          <View className="flex-row items-center border-b border-outline-variant/60 pb-2">
            <TextInput
              value={phone}
              onChangeText={setPhone}
              editable={stage === 'phone'}
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
                className={`text-[11px] font-semibold ${
                  countdown > 0 ? 'text-outline' : 'text-on-secondary-fixed'
                }`}>
                {countdown > 0 ? `重新发送 (${countdown}s)` : '发送验证码'}
              </Text>
            </View>
          </View>

          {stage !== 'phone' ? (
            <>
              <Text className="text-[11px] font-semibold tracking-wider text-outline mt-space-md mb-1">
                验证码
              </Text>
              <TextInput
                value={code}
                onChangeText={setCode}
                editable={stage === 'code'}
                keyboardType="number-pad"
                maxLength={6}
                placeholder="请输入 6 位验证码"
                placeholderTextColor="#707881"
                className="border-b border-outline-variant/60 pb-2 text-[16px] text-on-surface tracking-[0.4em]"
              />
            </>
          ) : null}

          {stage === 'phone' ? (
            <View className="mt-space-md">
              <Text className="text-[11px] font-semibold tracking-wider text-outline mb-space-xs">
                安全验证
              </Text>
              <SliderCaptcha disabled={busy} onValidated={onFirstSlider} />
            </View>
          ) : null}

          {stage === 'code' ? (
            <View className="mt-space-md">
              <PrimaryButton label="登录" onPress={submitCode} disabled={busy || code.length !== 6} />
              <Text
                onPress={() => {
                  setStage('phone');
                  setCode('');
                  setMessage('');
                }}
                className="text-center text-[13px] text-primary font-medium mt-space-sm">
                换一个手机号
              </Text>
            </View>
          ) : null}

          {stage === 'second-slider' ? (
            <View className="mt-space-md">
              <Text className="text-[11px] font-semibold tracking-wider text-outline mb-space-xs">
                安全验证
              </Text>
              <SliderCaptcha disabled={busy} onValidated={onSecondSlider} />
            </View>
          ) : null}

          {message ? (
            <View className="mt-space-md">
              <Banner text={message} tone={message.includes('失败') || message.includes('未') ? 'error' : 'info'} />
            </View>
          ) : null}
        </View>

        <Text className="text-[12px] text-outline text-center mt-space-lg leading-relaxed">
          登录会把官方 App 踢下线，两者不能同时在线。
        </Text>
      </ScrollView>
    </View>
  );
}
