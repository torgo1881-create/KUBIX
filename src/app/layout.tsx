import type { Metadata, Viewport } from 'next';

import './globals.css';

/**
 * Шрифты подключаются ссылкой, а не через next/font/google: тот качает
 * файлы во время сборки, и сборка без доступа к Google Fonts падает —
 * на CI или в закрытой сети. Ссылка грузится у пользователя, а при
 * недоступности остаётся системный шрифт из того же стека.
 */
const FONTS_URL =
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap';

export const metadata: Metadata = {
  icons: { icon: '/favicon.svg' },
  title: 'Фотомозаика — картина из деталей по вашей фотографии',
  description:
    'Загрузите фотографию, выберите набор и получите мозаику из деталей: несколько вариантов обработки, инструкция по сборке и PDF.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={FONTS_URL} />
      </head>
      <body className="min-h-screen grid-paper">{children}</body>
    </html>
  );
}
