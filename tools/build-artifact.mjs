/**
 * Версия для публикации как страницы (Artifact): берёт готовый
 * standalone/index.html и снимает с него внешний каркас документа —
 * хостинг добавляет свой <head> с viewport и сбросом стилей. Сверху
 * остаются <title> и <style>, дальше содержимое <body> как есть.
 *
 * Дополнительно подключаются шрифты IBM Plex с Google Fonts: автономный
 * файл живёт без сети и обходится системными, у страницы сеть есть.
 *
 * Запуск: node tools/build-artifact.mjs (после build:standalone)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'standalone/index.html'), 'utf8');

const pick = (open, close) => {
  const start = html.indexOf(open);
  const end = html.indexOf(close, start);
  if (start < 0 || end < 0) throw new Error(`Не нашёл ${open} в standalone/index.html`);
  return html.slice(start, end + close.length);
};

const title = pick('<title>', '</title>');
const style = pick('<style>', '</style>');
const bodyStart = html.indexOf('<body>') + '<body>'.length;
const bodyEnd = html.lastIndexOf('</body>');
const body = html.slice(bodyStart, bodyEnd);

const fonts =
  '<link rel="preconnect" href="https://fonts.googleapis.com" />\n' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />\n' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" />';

const page = `${title}\n${fonts}\n${style}\n${body.trim()}\n`;
writeFileSync(join(root, 'standalone/artifact.html'), page);
console.log(`standalone/artifact.html собран (${(page.length / 1024).toFixed(0)} КБ)`);
