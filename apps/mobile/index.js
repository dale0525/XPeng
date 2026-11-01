/**
 * 入口。必须先引入 `global.css`：NativeWind 靠它把 Tailwind 指令编译成 RN 样式，
 * 缺了这一步所有 className 静默失效（布局塌成流式、图标变豆腐块）。
 */
import './global.css';
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
