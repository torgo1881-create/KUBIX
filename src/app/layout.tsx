import type { Metadata, Viewport } from 'next';

import './globals.css';

/**
 * Шрифты подключаются ссылкой, а не через next/font/google: тот качает
 * файлы во время сборки, и сборка без доступа к Google Fonts падает —
 * на CI или в закрытой сети. Ссылка грузится у пользователя, а при
 * недоступности остаётся системный шрифт из того же стека.
 */
const FONTS_URL =
  'https://fonts.googleapis.com/css2?family=Montserrat+Alternates:wght@600;700;800&family=Mulish:wght@400;500;600;700;800&display=swap';

export const metadata: Metadata = {
  icons: { icon: '/favicon.svg' },
  title: 'Kubix — собери любое фото из деталей',
  description:
    'Один набор — и любая фотография становится картиной для стены. Загрузи снимок, выбери вариант обработки и получи схему сборки по блокам и PDF.',
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
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
