---
name: mobile-ui
description: 改自研客户端（apps/mobile）的 React Native 界面时加载。涉及 NativeWind 样式、动态样式切换、加载动画、界面卡死排查。
---

# 自研客户端界面

`apps/mobile` 用 React Native + NativeWind（Tailwind 指令编译成 RN 样式）。

## 动态 className 会把 JS 线程拖进死循环

**NativeWind 在运行中重新解析动态 `className` 会卡死 JS 线程**，表现为界面冻住、定时器全停、进程存活且无 ANR。

```
// 会死循环：每次渲染都拼出新的 class 字符串，触发 NativeWind 重新解析
className={`h-9 ${countdown > 0 ? 'opacity-50' : 'active:scale-95'}`}

// 正确：className 固定，动态部分走 style
className="h-9"
style={{ opacity: countdown > 0 ? 0.5 : 1 }}
```

不只透明度——凡是「条件切换 class 名」都算，包括 `bg-primary/50` 与 `bg-primary` 这类只差一个变体的写法。

### 症状与误判

2026-11-01 排查「验证码校验中一直卡住」「倒计时停在 1 秒」两轮都栽在这里，起初误判成网络请求没超时、定时器被重渲染打断，改了都不是。

判定特征：

1. `top -H -p <pid>` 看到 JS 线程（`mqt_v_js`）持续 70~100% CPU，累计时间一直涨；
2. 定时器、`console.log`、触摸回调**同时**停止，不只是某一个；
3. 进程存活、无 ANR、无崩溃日志；
4. CDP（Metro 的 `/json/list` + WebSocket）**连不上**——JS 线程被占满，连调试协议握手都进不去。

第 4 条最能区分「JS 线程死循环」与「应用挂起」：挂起时 CDP 仍能连。

### 定位手法

别靠猜。先加独立心跳（与出问题的逻辑无关的 `setInterval` 打日志），再对比心跳与出问题的定时器**是否同时停止**：

- 同时停 → 整个 JS 线程被占，往同步循环方向找；
- 只有业务定时器停 → 是 effect 依赖或清理的问题。

然后二分：把可疑处的动态 className 换成固定 class + `style`，重装验证。

## 照设计稿抄界面

稿子在 `docs/design/<screenId>.html`，是要被逐像素还原的**唯一依据**。别按描述自己重画样式——按稿子的 class 原样搬，只把硬编码数据换成语义 token 与真实字段。

- **亮暗是同一份结构**：两份稿（亮/暗）共用同一套语义 token 类名（`bg-surface`、`text-on-surface`），暗色不另写一份。稿子里的 hex 先查 `tailwind.config.js` 已定义的语义名再落类名，禁止在组件里写死 `#EDEDEF` 这类字面量。
- **判亮暗看背景类**：稿子大量用深色文字，数「深色出现次数」不可靠；看 `body` 或最外层容器的 `bg-` 指向哪个 token 才能定论。
- **间距必须整段抄，不能逐块凑**：容器、卡片内边距、卡内块间距是三处独立的值，各自漏了都会让整屏显得挤。以车控稿（`a694…`）为准的实测值：内容容器 `px-4 pt-2.5 gap-4`、卡片 `p-5`、卡内块之间 `space-y-4`（16px）。只改字号不改这三处，看起来就是「字号对了但排版还是不对」。
- **别自己发明交互态**：稿里按钮是什么样就是什么样。曾自造过一个按钮组件，带 pending/success/failed 变色，稿里根本没有——用户的评价是「我让你用 stitch 设计就是为了抄作业」。用户要的融合（状态并入控制卡）也靠**分组与视觉区分**表达，不是靠给状态格套按钮外衣。
- **稿中没有取值的字段不要猜**：逆向文档里只有字段名、没有枚举语义的（如 `charge_connector_status`，真机先后见过 `0` 和 `7`），显示 `—` 而不是裸数字。
- **稿是静态的，动效要重写**：稿里的动画（如充电水面铺满）在 RN 里得用 `Animated` 重做，不能指望照搬；静态帧与实现层动效的差异要提前跟用户确认。

## 其他

- 样式库是 NativeWind，用 Tailwind 类名，与 Stitch 设计稿一致（具体抄法见上一节）。
- 图标走 Material Symbols 字体子集（`src/ui/icons.ts` + `android/app/src/main/assets/fonts/`）。引用前确认该字形在字体里存在，否则渲染成豆腐块。
- 加载动画用 `src/ui/atoms.tsx` 的 `SpinnerIcon`（`Animated` + `Easing.linear`），不用平台 `ActivityIndicator`——字体与配色不匹配。
- 原生模块若用 `NativeEventEmitter`，必须提供 `addListener` / `removeListeners` 空实现，否则开发版会顶出黄色 LogBox 条。
