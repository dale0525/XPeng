/**
 * 入口。必须先引入 `global.css`：NativeWind 靠它把 Tailwind 指令编译成 RN 样式，
 * 缺了这一步所有 className 静默失效（布局塌成流式、图标变豆腐块）。
 */
import { AppRegistry, LogBox } from 'react-native';

/**
 * 屏蔽一条第三方库自己的弃用警告。
 *
 * NativeWind 的运行时（`react-native-css-interop`）在模块加载时就对
 * `ImageBackground` 调 `remapProps`，而 RN 0.8x 把 `ImageBackground` 标了
 * `@deprecated`，取一次属性就 `warnOnce` 一次。我们自己的代码没有任何一处用
 * `ImageBackground`，这条警告改不掉（在 node_modules 里），但开发版会因此在
 * 屏幕底部顶出一条黄色 LogBox 条盖住页面内容。
 *
 * 只屏蔽这一条，不做 `ignoreAllLogs`——其他警告仍然要能看见。
 *
 * 注意这里必须用 `require` 而不是 `import` 引 `global.css`：ES import 会被提升到
 * 所有语句之前执行，那样 NativeWind 会在本行注册之前就触发警告，屏蔽失效。
 */
LogBox.ignoreLogs([/ImageBackground is deprecated/]);

require('./global.css');

const App = require('./App').default;
const appName = require('./app.json').name;

AppRegistry.registerComponent(appName, () => App);

// 桌面组件的无界面任务必须在启动时注册：原生拉起进程时不走界面入口，
// 只有这里注册过，WidgetHeadlessService 才能按名字找到它。
require('./src/core/widget-task');
