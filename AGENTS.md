# XPeng

小鹏汽车 App 逆向取证与自研客户端。请求签名、mTLS、令牌续期、MQTT 车控均已闭环；**登录链路 2026-11-01 端到端打通**（发码 → 验证码 → 第二道滑块 `drag/validate{sceneType:"LGN"}` → `smsLogin` 200 → 解开 `sData` 拿到 AT/RT），见研究文档 §4.2。三个必要条件：第二道滑块场景是 `LGN`（不是发码用的 `SMS`）、换 token 打 `v5/smsLogin`、解 `sData` 必须用**同一次请求的服务端密钥池**（该池每次请求都变，用本地 tee 或事后重取一律 `InvalidTag`）。换到的 token 打业务接口时**必须带 `Xp-Uid` = `sData.uid`**（在算 `xpSign` 之前设好），否则恒 `12010101`；设好即 `200` 并列出车辆。

## 硬门禁

- `work/live/` 下的 token、`work/` 下的 APK 与 dump **不进版本库**，也不要把 token 贴进回复或文档。
- 涉及真实账号登录时记住**单会话约束**：自研客户端登录会把官方 App 踢下线。
- 抓包、内存 dump 只在本机模拟器上做，不对线上服务做压力或枚举式探测。

## 事实来源

- `docs/research/xpeng-app-teardown.md` —— 逆向结论的唯一事实文档（端点、签名、令牌、错误码、已推翻的假设）。改动前先读对应章节。
- `CONTEXT.md` —— 术语表。

## 目录

```
scripts/    可执行工具（probe.py 签名、selfclient.py 自研客户端、renew.py 续期、unseal-token.py 解封、
            login.py 登录链路、login-ui.py 滑块页面、check-ticket.py 验票、grab-ticket.py 从堆快照取票）
docs/       研究与计划
work/       APK、dump、live token（gitignore）
```

## 项目技能

| 触发 | 技能 |
| --- | --- |
| 启动/截屏/点击取证模拟器，跑官方 App 走登录或滑块，从模拟器取文件 | [`.agents/skills/android-emulator`](.agents/skills/android-emulator/SKILL.md) |
| 改自研客户端 `apps/mobile` 的界面：NativeWind 样式、动态样式切换、加载动画、界面卡死排查 | [`.agents/skills/mobile-ui`](.agents/skills/mobile-ui/SKILL.md) |
