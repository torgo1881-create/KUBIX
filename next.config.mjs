/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Сервер со всем нужным в .next/standalone — для Docker-образа без node_modules.
  output: 'standalone',
  async rewrites() {
    return {
      // Главная и /m — полная версия генератора (автономная страница из
      // public/m, собирается при npm run build). React-приложение — на /lab.
      beforeFiles: [
        { source: '/', destination: '/m/index.html' },
        { source: '/m', destination: '/m/index.html' },
      ],
    };
  },
};

export default nextConfig;
