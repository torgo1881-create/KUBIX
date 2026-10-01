import type { Config } from 'tailwindcss';

const channel = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: channel('border'),
        input: channel('input'),
        ring: channel('ring'),
        background: channel('background'),
        foreground: channel('foreground'),
        // Чернила: текст, тёмные блоки и подложки под мозаику.
        ink: channel('foreground'),
        'on-ink': channel('on-ink'),
        peach: channel('peach'),
        mint: channel('mint'),
        primary: {
          DEFAULT: channel('primary'),
          hover: channel('primary-hover'),
          foreground: channel('primary-foreground'),
        },
        secondary: {
          DEFAULT: channel('secondary'),
          foreground: channel('secondary-foreground'),
        },
        muted: {
          DEFAULT: channel('muted'),
          foreground: channel('muted-foreground'),
        },
        accent: {
          DEFAULT: channel('accent'),
          foreground: channel('accent-foreground'),
        },
        destructive: {
          DEFAULT: channel('destructive'),
          foreground: channel('destructive-foreground'),
        },
        card: {
          DEFAULT: channel('card'),
          foreground: channel('card-foreground'),
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['Mulish', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Montserrat Alternates"', 'Mulish', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      keyframes: {
        'stripe-shift': {
          from: { backgroundPosition: '0 0' },
          to: { backgroundPosition: '32px 0' },
        },
      },
      animation: {
        'stripe-shift': 'stripe-shift 1s linear infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
