/**
 * Сводка по выбору людей: разбор экспортов, сеансы, победители, порядок
 * ленты и то, что генератор вариантов этот порядок применяет.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_GAP_MS,
  buildRanking,
  extractRecords,
  formatChoiceReport,
  mergeRecords,
  rankWins,
  sessionize,
  summarizeChoices,
} from '../src/services/choiceAnalysis.ts';
import { ALL_VARIANT_PRESETS, orderByRanking, rankingKey } from '../src/config/variants.ts';

const categoryOf = (preset) => (preset.startsWith('classic') ? 'classic' : preset.startsWith('color') ? 'color' : 'unknown');

function click(t, variant, preset, extra = {}) {
  return { t, variant, preset, faces: 1, score: 70, ...extra };
}

test('экспорт из интерфейса и голый массив разбираются одинаково, мусор отбрасывается', () => {
  const list = [click(1, 'A', 'classic-s'), { t: 2, variant: 7, preset: 'x' }, null, 'str', { variant: 'B', preset: 'color-m' }];
  const fromExport = extractRecords({ total: 5, byVariant: {}, choices: list });
  const fromArray = extractRecords(list);
  assert.deepEqual(fromExport, fromArray);
  assert.equal(fromExport.length, 2);
  assert.equal(fromExport[1].t, 0, 'без времени — ноль, но запись остаётся');
  assert.deepEqual(extractRecords('нет'), []);
});

test('слияние экспортов не удваивает одинаковые клики', () => {
  const a = [click(10, 'A', 'classic-s', { session: 's1' }), click(20, 'B', 'classic-s', { session: 's1' })];
  const b = [click(20, 'B', 'classic-s', { session: 's1' }), click(30, 'C', 'color-m', { session: 's2' })];
  const merged = mergeRecords([{ choices: a }, b]);
  assert.deepEqual(merged.map((record) => `${record.t}:${record.variant}`), ['10:A', '20:B', '30:C']);
});

test('сеансы: по session, а без него — по набору и паузе; решение — последний клик', () => {
  const records = [
    click(1000, 'A', 'classic-s', { session: 's1' }),
    click(2000, 'I', 'classic-s', { session: 's1' }),
    click(3000, 'B', 'classic-s', { session: 's1' }),
    // старые записи без сеанса
    click(10_000, 'C', 'color-m'),
    click(10_000 + SESSION_GAP_MS - 1, 'D', 'color-m'),
    click(10_000 + SESSION_GAP_MS * 3, 'E', 'color-m'),
    click(10_000 + SESSION_GAP_MS * 3 + 5, 'F', 'classic-m', { faces: 0 }),
  ];
  const sessions = sessionize(records, categoryOf);
  assert.deepEqual(
    sessions.map((session) => `${session.preset}:${session.final.variant}:${session.clicks.length}`),
    ['classic-s:B:3', 'color-m:D:2', 'color-m:E:1', 'classic-m:F:1'],
  );
  assert.equal(sessions[0].category, 'classic');
  assert.equal(sessions[3].faces, false);
});

test('сводка: победы всего, по группам, доля сравнений и позиция победителя', () => {
  const records = [];
  let t = 0;
  const session = (preset, finalVariant, faces, index, explore = []) => {
    const id = `s${records.length}`;
    for (const variant of explore) records.push(click((t += 1000), variant, preset, { session: id, faces }));
    records.push(click((t += 1000), finalVariant, preset, { session: id, faces, index }));
  };
  for (let i = 0; i < 12; i++) session('classic-s', 'I', 1, 8, i % 3 === 0 ? ['A'] : []);
  for (let i = 0; i < 6; i++) session('classic-m', 'B', 1, 1);
  for (let i = 0; i < 4; i++) session('color-m', 'C', 0, 3);
  for (let i = 0; i < 2; i++) session('color-m', 'A', 1, 0);

  const report = summarizeChoices(records, { categoryOf });
  assert.equal(report.sessions, 24);
  assert.deepEqual(rankWins(report.overall).slice(0, 2).map((item) => `${item.id}:${item.wins}`), ['I:12', 'B:6']);

  const classicFace = report.byGroup[rankingKey('classic', true)];
  assert.equal(classicFace.sessions, 18);
  assert.deepEqual(classicFace.wins, { I: 12, B: 6 });
  assert.deepEqual(report.byGroup[rankingKey('color', false)].wins, { C: 4 });
  assert.deepEqual(report.byPreset['color-m'].wins, { C: 4, A: 2 });

  assert.ok(Math.abs(report.explored - 4 / 24) < 1e-9, 'четыре сеанса из 24 сравнивали');
  assert.ok(report.meanWinnerIndex > 0);

  // Победители в classic (I и B) — с подъёмом лица; среднее по показанным ниже единицы.
  const lean = report.leans[rankingKey('classic', true)].find((item) => item.key === 'faceExposure');
  assert.equal(lean.winners, 1);
  assert.ok(lean.shown < 1);

  const text = formatChoiceReport(report, 10);
  assert.match(text, /решений \(сеансов\): 24/);
  assert.match(text, /classic, с лицом — 18 решений/);
  assert.match(text, /мало данных/, 'группы меньше порога помечены');
});

test('порядок ленты пишется только для групп с достаточным числом решений', () => {
  const records = [];
  for (let i = 0; i < 10; i++) records.push(click(i * 1000, i < 7 ? 'I' : 'B', 'classic-s', { session: `a${i}` }));
  for (let i = 0; i < 3; i++) records.push(click(100_000 + i * 1000, 'C', 'color-s', { session: `b${i}` }));
  records.push(click(500_000, 'D', 'mystery', { session: 'c' }));

  const report = summarizeChoices(records, { categoryOf });
  const ranking = buildRanking(report, 10, new Date('2026-10-01T00:00:00Z'));
  assert.deepEqual(ranking.rankings, { 'classic|face': ['I', 'B'] });
  assert.equal(ranking.updatedAt, '2026-10-01');
  assert.equal(ranking.minSessions, 10);
  assert.ok(!('any|face' in buildRanking(report, 1).rankings), 'неизвестный набор в порядок не попадает');
});

test('генератор применяет порядок: первым идёт победитель, остальные как были', () => {
  const ids = ALL_VARIANT_PRESETS.map((preset) => preset.id);
  const ordered = orderByRanking(ALL_VARIANT_PRESETS, ['I', 'B']).map((preset) => preset.id);
  assert.deepEqual(ordered.slice(0, 2), ['I', 'B']);
  assert.deepEqual(ordered.slice(2), ids.filter((id) => id !== 'I' && id !== 'B'));
});
