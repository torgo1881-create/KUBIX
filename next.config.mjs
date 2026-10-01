/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Сервер со всем нужным в .next/standalone — для Docker-образа без node_modules.
  output: 'standalone',
  async rewrites() {
    return {
      // Главная — лендинг и генератор Kubix (src/app/page.tsx). По адресу /m
      // остаётся автономная страница из public/m (собирается при npm run
      // build), а лаборатория алгоритма — на /lab.
      beforeFiles: [{ source: '/m', destination: '/m/index.html' }],
    };
  },
};

export default nextConfig;
