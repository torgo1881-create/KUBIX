/**
 * Кладёт автономную страницу в public/m — Next отдаёт её по адресу /m.
 * Это мобильная и тестовая версия: та же, что открывается файлом.
 *
 * Запуск: node tools/publish-standalone.mjs (вызывается из npm run build)
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'standalone/index.html');
if (!existsSync(source)) {
  console.error('Нет standalone/index.html — сначала npm run build:standalone');
  process.exit(1);
}
mkdirSync(join(root, 'public/m'), { recursive: true });
copyFileSync(source, join(root, 'public/m/index.html'));
console.log('public/m/index.html обновлён');
