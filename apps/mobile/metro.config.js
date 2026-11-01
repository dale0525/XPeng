const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const { withNativeWind } = require('nativewind/metro');

const workspaceRoot = path.resolve(__dirname, '../..');
const base = getDefaultConfig(__dirname);

// monorepo：Metro 只默认监听项目目录，workspace 包在 ../../packages 下
const config = mergeConfig(base, {
  watchFolders: [workspaceRoot],
  resolver: {
    nodeModulesPaths: [
      path.resolve(__dirname, 'node_modules'),
      path.resolve(workspaceRoot, 'node_modules'),
    ],
  },
});

module.exports = withNativeWind(config, { input: './global.css' });
