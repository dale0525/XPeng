---
name: android-widget
description: 改 `apps/mobile` 的桌面组件（Android AppWidget / RemoteViews）时加载。涉及新增或调整组件规格、改组件布局与文案、组件点击下发车控、组件读数刷新、排查「无法加载微件」或图标豆腐块。
---

# 桌面组件

三档组件（2×2 / 1×4 / 2×4）在 `apps/mobile/android/app/src/main/java/com/logiconsole/xpcarinfo/widgets/`，
布局与资源在 `android/app/src/main/res/{layout,xml,drawable,values,values-night}/widget_*`，
设计稿在 `docs/design/<screenId>.html`（预览图在 `docs/design/preview/widget-*.png`）。

交付前至少验证三件事：`npx tsc --noEmit`、`:app:assembleDebug`、组件在真机组件库里的预览（见末节）。

## RemoteViews 只认一批白名单类

布局里出现裸 `View`、`Space` 之类的占位控件，launcher inflate 时会抛
`Class not allowed to be inflated android.view.View`，桌面显示「无法加载微件」。
**间距一律用 `layout_margin`**，不要用空 View 撑开。

同理不能用的还有：

- **自定义控件**（除 `@RemoteView` 注解过的）——组件里只能用 `LinearLayout`、`FrameLayout`、`TextView`、`ImageView`、`ProgressBar` 这些框架类；
- **`android:fontFamily` 指向应用内字体**——见下节；
- **`setViewLayoutWidth`**——要 API 31，本项目 minSdk 是 26。

排查「无法加载微件」先看 `adb logcat | grep "Error inflating"`，堆栈里的行号直接指到布局的哪一行。

## 图标不能用字体，必须预渲染位图

launcher 跑在自己进程里，**拿不到应用打包的字体**。早期用 `fontFamily="@font/material_symbols"`
直出 Material Symbols 码位，四个图标全渲染成豆腐块（2026-11-13，Pixel 4a / Android 13 实测）。

现在的做法：`res/drawable/widget_icon_{light,dark}_<0..3>.png`，亮暗各一套（亮色深灰、暗色浅白，
不靠 tint 反相），顺序与 `WidgetShortcuts.ALL` 的声明顺序一致。车辆图同理
（`widget_car_light.png` / `widget_car_dark.png`）。

新增一格或换图标时，两套位图都要补，并按序号对齐。

## 组件规格由 minWidth/minHeight 决定，不是 targetCell

只写 `targetCellWidth/Height` 而不写 `minWidth/minHeight`，launcher 会按最小尺寸分配格位——
2×2 组件被分到 1 列宽的窄条，四格标签全截成「远…」「开…」（实测）。

`minWidth/minHeight` 用经典格位公式：**每格 70dp 减 30dp**。

| 规格 | minWidth | minHeight |
| --- | --- | --- |
| 2×2 | 110dp | 110dp |
| 1×4 | 250dp | 40dp |
| 2×4 | 250dp | 110dp |

改完尺寸要**重新添加**组件实例才会生效：已放到桌面的实例沿用添加时的格位，
改代码不会让老实例自动变大。验证时清一次 launcher 数据（`pm clear com.google.android.apps.nexuslauncher`）再重新添加。

## 点击下发走无界面 JS 任务

签名链路、密钥池、MQTT 凭据全在 TypeScript，原生侧没有，所以原生做不了下发。
按钮点击 → `WidgetActionReceiver` → `WidgetHeadlessService` 起无界面 RN 运行时 → JS `runWidgetCommand()`。

- 任务名 `XpengWidgetAction` 在两侧各写了一遍（`WidgetHeadlessService.TASK_KEY` 与
  `widget-task.ts` 的 `registerHeadlessTask`），**必须逐字一致**，改一处要改两处；
- 只能 `startService`，不能 `startForegroundService`——`HeadlessJsTaskService` 不会
  `startForeground`，前台服务变体五秒内被系统判 ANR 杀掉；
- 无界面任务里 `sessionStore` 停在 `loading`（`init()` 原本只在 `App.tsx` 的 effect 里跑），
  不主动初始化会把每次点击都判成「未登录」。`runWidgetCommand` 里已补这一步；
- P5 的门锁与闪灯走 BLE V2，下发前要先 `bleLink.autoPrepareV2()`，否则
  `executePreparedV2` 抛 `context is not prepared`。

## 读数刷新靠 App 推送

`updatePeriodMillis` 系统下限是 30 分钟，撑不住电量续航这类读数，所以置 0、改由 App 推：
JS 拿到状态帧就写 `widget.snapshot` 到 SharedPreferences（`xpeng` 同名，键
`StorageKey.widgetSnapshot`），再调原生 `refreshWidgets()` 让组件重画。

**没有读数时显示「—」而不是 0**：`WidgetSnapshot` 用 `Int?`，能量条 `setProgressBar` 的
indeterminate 位传 `soc == null`。宁可空条，也不要让用户把上次的数字当成现在的。

## 验收：用组件库预览代替拖放

ADB 模拟不了 launcher 的长按拖动，`input swipe` / `input motionevent` 都放不上桌面。
改用组件库预览——它同样是真实 RemoteViews inflate 真实布局，能验证渲染、尺寸与亮暗：

```
adb shell input swipe 540 700 540 700 1200   # 长按桌面
adb shell input tap 768 342                  # 微件
adb shell input tap 540 2160                 # 关掉首次提示
```

滚动到 `小鹏友` 后展开，`uiautomator dump` 里 `com.logiconsole.xpcarinfo:id/widget_root`
的 bounds 就是实际渲染尺寸。暗色用 `adb shell cmd uimode night yes` 切换，切完要
`am force-stop com.google.android.apps.nexuslauncher` 让 launcher 重新读配置。
