/**
 * Сводка по выбору вариантов людьми.
 *
 *   npm run choices -- exports/*.json          — отчёт по экспортам из Advanced
 *   npm run choices -- exports/ --apply        — ещё и записать порядок ленты
 *   npm run choices -- exports/ --min 20       — порог решений на группу (по умолчанию 10)
 *
 * На вход — файлы «Экспорт выборов вариантов» из интерфейса (можно папку).
 * Внутри сеанса человек щёлкает по ленте и сравнивает; решением считается
 * последний клик. Отчёт показывает, какие варианты побеждают всего, по
 * наборам и по группам «тип набора × есть лицо», и чем настройки
 * победителей отличаются от среднего.
 *
 * С --apply порядок победителей для групп, где решений не меньше порога,
 * пишется в src/config/variantRanking.json: лента показывает их первыми,
 * первый становится выбором по умолчанию. Настройки вариантов не меняются.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getPreset } from '../src/config/productPresets.ts';
import { buildRanking, formatChoiceReport, mergeRecords, summarizeChoices } from '../src/services/choiceAnalysis.ts';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const minIndex = args.indexOf('--min');
const MIN_SESSIONS = minIndex >= 0 ? Number(args[minIndex + 1]) || 10 : 10;
const inputs = args.filter((arg, index) => !arg.startsWith('--') && !(index > 0 && args[index - 1] === '--min'));

if (!inputs.length) {
  console.error('Укажите экспорты выборов: npm run choices -- exports/*.json [--apply] [--min 10]');
  process.exit(2);
}

const files = [];
for (const input of inputs) {
  if (!existsSync(input)) {
    console.error(`Нет файла: ${input}`);
    process.exit(2);
  }
  if (statSync(input).isDirectory()) {
    for (const name of readdirSync(input).filter((f) => f.endsWith('.json')).sort()) files.push(join(input, name));
  } else {
    files.push(input);
  }
}

const payloads = files.map((file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`Не разобрать ${file}: ${error.message}`);
    process.exit(2);
  }
});

const categoryOf = (presetId) => {
  try {
    return getPreset(presetId).category;
  } catch {
    return 'unknown';
  }
};

const records = mergeRecords(payloads);
const report = summarizeChoices(records, { categoryOf });

console.log(`Файлов: ${files.length}`);
console.log(formatChoiceReport(report, MIN_SESSIONS));

const ranking = buildRanking(report, MIN_SESSIONS);
const groups = Object.keys(ranking.rankings);

if (APPLY) {
  if (!groups.length) {
    console.log(`\n--apply пропущен: ни в одной группе нет ${MIN_SESSIONS} решений.`);
  } else {
    const path = 'src/config/variantRanking.json';
    writeFileSync(path, JSON.stringify(ranking, null, 2) + '\n');
    console.log(`\nЗаписано в ${path}:`);
    for (const key of groups) console.log(`  ${key}: ${ranking.rankings[key].join(' › ')}`);
    console.log('Дальше: npm test, npm run build:standalone.');
  }
} else if (groups.length) {
  console.log('\nПорядок ленты, который запишет --apply:');
  for (const key of groups) console.log(`  ${key}: ${ranking.rankings[key].join(' › ')}`);
}
