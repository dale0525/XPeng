/**
 * 设计令牌，逐项抄自 `docs/design/*.html` 的 `tailwind.config` 段。
 *
 * 颜色只出现一次语义名，取值在 `src/core/colors.ts` 里按亮/暗各给一份，运行时由根
 * 节点注入 CSS 变量。所以组件里写 `bg-surface` 就同时适配两种主题，不用写 `dark:`。
 *
 * 字号令牌保留了设计稿的 lineHeight / letterSpacing / fontWeight，否则
 * `text-headline-sm` 这类类名拿不到设计稿的行高与字距，像素还原会差一截。
 */
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./App.tsx', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: 'var(--c-surface)',
        'surface-dim': 'var(--c-surface-dim)',
        'surface-bright': 'var(--c-surface-bright)',
        'surface-container-lowest': 'var(--c-surface-container-lowest)',
        'surface-container-low': 'var(--c-surface-container-low)',
        'surface-container': 'var(--c-surface-container)',
        'surface-container-high': 'var(--c-surface-container-high)',
        'surface-container-highest': 'var(--c-surface-container-highest)',
        'surface-variant': 'var(--c-surface-variant)',
        'on-surface': 'var(--c-on-surface)',
        'on-surface-variant': 'var(--c-on-surface-variant)',
        'inverse-surface': 'var(--c-inverse-surface)',
        'inverse-on-surface': 'var(--c-inverse-on-surface)',
        outline: 'var(--c-outline)',
        'outline-variant': 'var(--c-outline-variant)',
        'surface-tint': 'var(--c-surface-tint)',
        primary: 'var(--c-primary)',
        'on-primary': 'var(--c-on-primary)',
        'primary-container': 'var(--c-primary-container)',
        'on-primary-container': 'var(--c-on-primary-container)',
        'inverse-primary': 'var(--c-inverse-primary)',
        'primary-fixed': 'var(--c-primary-fixed)',
        'primary-fixed-dim': 'var(--c-primary-fixed-dim)',
        'on-primary-fixed': 'var(--c-on-primary-fixed)',
        'on-primary-fixed-variant': 'var(--c-on-primary-fixed-variant)',
        secondary: 'var(--c-secondary)',
        'on-secondary': 'var(--c-on-secondary)',
        'secondary-container': 'var(--c-secondary-container)',
        'on-secondary-container': 'var(--c-on-secondary-container)',
        'secondary-fixed': 'var(--c-secondary-fixed)',
        'secondary-fixed-dim': 'var(--c-secondary-fixed-dim)',
        'on-secondary-fixed': 'var(--c-on-secondary-fixed)',
        'on-secondary-fixed-variant': 'var(--c-on-secondary-fixed-variant)',
        tertiary: 'var(--c-tertiary)',
        'on-tertiary': 'var(--c-on-tertiary)',
        'tertiary-container': 'var(--c-tertiary-container)',
        'on-tertiary-container': 'var(--c-on-tertiary-container)',
        'tertiary-fixed': 'var(--c-tertiary-fixed)',
        'tertiary-fixed-dim': 'var(--c-tertiary-fixed-dim)',
        'on-tertiary-fixed': 'var(--c-on-tertiary-fixed)',
        'on-tertiary-fixed-variant': 'var(--c-on-tertiary-fixed-variant)',
        error: 'var(--c-error)',
        'on-error': 'var(--c-on-error)',
        'error-container': 'var(--c-error-container)',
        'on-error-container': 'var(--c-on-error-container)',
        background: 'var(--c-background)',
        'on-background': 'var(--c-on-background)',
        success: 'var(--c-success)',
      },
      fontFamily: {
        // 设计稿的三支柱：标题 Anybody、正文 Space Grotesk、遥测读数 Space Mono
        headline: ['Anybody'],
        display: ['Anybody'],
        label: ['Anybody'],
        body: ['SpaceGrotesk'],
        mono: ['SpaceMono'],
        // 图标就是字形：靠 className 控字号与颜色
        icon: ['MaterialSymbols'],
      },
      fontSize: {
        'display-hero': ['56px', { lineHeight: '56px', letterSpacing: '-0.04em', fontWeight: '900' }],
        'display-hero-mobile': [
          '42px',
          { lineHeight: '44px', letterSpacing: '-0.03em', fontWeight: '900' },
        ],
        'headline-lg': ['36px', { lineHeight: '40px', letterSpacing: '-0.02em', fontWeight: '800' }],
        'headline-lg-mobile': [
          '28px',
          { lineHeight: '32px', letterSpacing: '-0.02em', fontWeight: '800' },
        ],
        'headline-md': ['24px', { lineHeight: '28px', letterSpacing: '-0.01em', fontWeight: '700' }],
        'headline-sm': ['20px', { lineHeight: '24px', letterSpacing: '0em', fontWeight: '700' }],
        'telemetry-readout': [
          '32px',
          { lineHeight: '32px', letterSpacing: '-0.05em', fontWeight: '700' },
        ],
        'body-lg': ['18px', { lineHeight: '26px', letterSpacing: '-0.01em', fontWeight: '500' }],
        'body-md': ['15px', { lineHeight: '22px', letterSpacing: '0em', fontWeight: '400' }],
        'body-sm': ['13px', { lineHeight: '18px', letterSpacing: '0.01em', fontWeight: '400' }],
        'label-badge': ['12px', { lineHeight: '14px', letterSpacing: '0.12em', fontWeight: '800' }],
        'label-mono': ['11px', { lineHeight: '14px', letterSpacing: '0.06em', fontWeight: '400' }],
      },
      borderRadius: {
        DEFAULT: '0.125rem',
        lg: '0.25rem',
        xl: '0.5rem',
        full: '0.75rem',
      },
      spacing: {
        gutter: '1rem',
        margin: '1rem',
        'space-xs': '0.25rem',
        'space-sm': '0.5rem',
        'space-md': '0.875rem',
        'space-lg': '1.25rem',
        'space-xl': '2rem',
        'space-2xl': '3rem',
      },
    },
  },
  plugins: [],
};
