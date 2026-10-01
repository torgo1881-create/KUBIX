import { ALL_VARIANT_PRESETS, rankingKey, type VariantCategory, type VariantPreset, type VariantRanking } from '../config/variants';
import { TUNABLE_PARAMS, settingsToVector } from '../algorithms/experimental/tuning';

/**
 * Сводка по выбору вариантов людьми.
 *
 * Интерфейс пишет каждый клик по ленте: id варианта, набор, найдено ли
 * лицо, оценка, сеанс генерации и позиция в ленте. Здесь из кликов
 * получаются решения: внутри одного сеанса человек щёлкает и сравнивает,
 * а выбором считается последний клик. Из решений — доли побед по типам
 * наборов и по наличию лица, «наклон» параметров у победителей и порядок
 * ленты для variantRanking.json.
 *
 * Логика чистая и проверяется тестом; чтение файлов — в tools/choices-report.mjs.
 */

export interface ChoiceRecord {
  /** Время клика, мс. */
  t: number;
  variant: string;
  preset: string;
  /** Сколько лиц нашёл детектор на кадре. */
  faces: number;
  score?: number;
  /** Сеанс генерации — одна лента вариантов. Старые записи его не имеют. */
  session?: string;
  /** Позиция варианта в ленте на момент клика. */
  index?: number;
}

export interface ChoiceSession {
  id: string;
  preset: string;
  category: VariantCategory | 'unknown';
  faces: boolean;
  clicks: ChoiceRecord[];
  /** Последний клик — то, с чем человек остался. */
  final: ChoiceRecord;
}

export interface WinTable {
  sessions: number;
  /** id варианта → число побед. */
  wins: Record<string, number>;
}

export interface ParameterLean {
  key: string;
  label: string;
  /** Среднее по настройкам вариантов-победителей (взвешено числом побед). */
  winners: number;
  /** Среднее по всем вариантам, которые показывались этой группе. */
  shown: number;
}

export interface ChoiceReport {
  records: number;
  sessions: number;
  overall: WinTable;
  byPreset: Record<string, WinTable>;
  /** Ключ — rankingKey(category, faces). */
  byGroup: Record<string, WinTable>;
  /** Доля сеансов, где финальный выбор отличается от первого клика. */
  explored: number;
  /** Средняя позиция победителя в ленте — виден ли сдвиг «берут первое». */
  meanWinnerIndex: number | null;
  leans: Record<string, ParameterLean[]>;
}

/** Промежуток между кликами, после которого старые записи без сеанса считаются новым сеансом. */
export const SESSION_GAP_MS = 120_000;

/** Принимает экспорт из интерфейса (объект с choices) или просто массив записей. */
export function extractRecords(payload: unknown): ChoiceRecord[] {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { choices?: unknown }).choices)
      ? (payload as { choices: unknown[] }).choices
      : [];
  const records: ChoiceRecord[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.variant !== 'string' || typeof raw.preset !== 'string') continue;
    const t = typeof raw.t === 'number' && Number.isFinite(raw.t) ? raw.t : 0;
    records.push({
      t,
      variant: raw.variant,
      preset: raw.preset,
      faces: typeof raw.faces === 'number' ? raw.faces : 0,
      ...(typeof raw.score === 'number' ? { score: raw.score } : {}),
      ...(typeof raw.session === 'string' ? { session: raw.session } : {}),
      ...(typeof raw.index === 'number' ? { index: raw.index } : {}),
    });
  }
  return records;
}

/** Объединяет несколько экспортов; одинаковые записи (один клик в двух файлах) не удваиваются. */
export function mergeRecords(payloads: unknown[]): ChoiceRecord[] {
  const seen = new Set<string>();
  const merged: ChoiceRecord[] = [];
  for (const payload of payloads) {
    for (const record of extractRecords(payload)) {
      const key = `${record.t}|${record.variant}|${record.preset}|${record.session ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(record);
    }
  }
  return merged.sort((a, b) => a.t - b.t);
}

/**
 * Клики → сеансы. Записи с полем session группируются по нему; старые, без
 * сеанса, — по набору и паузе между кликами.
 */
export function sessionize(
  records: ChoiceRecord[],
  categoryOf: (presetId: string) => VariantCategory | 'unknown',
  gapMs = SESSION_GAP_MS,
): ChoiceSession[] {
  const sorted = [...records].sort((a, b) => a.t - b.t);
  const groups = new Map<string, ChoiceRecord[]>();
  let fallbackCounter = 0;
  let lastFallback: { key: string; preset: string; t: number } | null = null;

  for (const record of sorted) {
    let key: string;
    if (record.session) {
      key = `s:${record.session}`;
    } else if (lastFallback && lastFallback.preset === record.preset && record.t - lastFallback.t <= gapMs) {
      key = lastFallback.key;
    } else {
      key = `f:${++fallbackCounter}`;
    }
    if (!record.session) lastFallback = { key, preset: record.preset, t: record.t };
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }

  const sessions: ChoiceSession[] = [];
  for (const [id, clicks] of groups) {
    const final = clicks[clicks.length - 1];
    sessions.push({
      id,
      preset: final.preset,
      category: categoryOf(final.preset),
      faces: clicks.some((click) => click.faces > 0),
      clicks,
      final,
    });
  }
  return sessions;
}

function tally(sessions: ChoiceSession[]): WinTable {
  const wins: Record<string, number> = {};
  for (const session of sessions) wins[session.final.variant] = (wins[session.final.variant] ?? 0) + 1;
  return { sessions: sessions.length, wins };
}

/** Победители отсортированы по убыванию; при равенстве — по id, чтобы порядок был воспроизводим. */
export function rankWins(table: WinTable): Array<{ id: string; wins: number; share: number }> {
  return Object.entries(table.wins)
    .map(([id, wins]) => ({ id, wins, share: table.sessions ? wins / table.sessions : 0 }))
    .sort((a, b) => b.wins - a.wins || a.id.localeCompare(b.id));
}

function leanFor(table: WinTable, shown: VariantPreset[]): ParameterLean[] {
  if (!shown.length || !table.sessions) return [];
  const vectors = new Map(shown.map((preset) => [preset.id, settingsToVector(preset.settings)]));
  const leans: ParameterLean[] = [];
  for (const param of TUNABLE_PARAMS) {
    let winnerSum = 0;
    let winnerCount = 0;
    for (const [id, count] of Object.entries(table.wins)) {
      const vector = vectors.get(id);
      if (!vector) continue;
      winnerSum += (vector[param.key] ?? 0) * count;
      winnerCount += count;
    }
    const shownMean = shown.reduce((sum, preset) => sum + (vectors.get(preset.id)?.[param.key] ?? 0), 0) / shown.length;
    if (!winnerCount) continue;
    leans.push({ key: param.key, label: param.label, winners: winnerSum / winnerCount, shown: shownMean });
  }
  return leans;
}

export interface SummarizeOptions {
  categoryOf: (presetId: string) => VariantCategory | 'unknown';
  presets?: VariantPreset[];
}

export function summarizeChoices(records: ChoiceRecord[], options: SummarizeOptions): ChoiceReport {
  const presets = options.presets ?? ALL_VARIANT_PRESETS;
  const sessions = sessionize(records, options.categoryOf);

  const byPreset: Record<string, WinTable> = {};
  const byGroup: Record<string, WinTable> = {};
  const groupSessions = new Map<string, ChoiceSession[]>();
  const presetSessions = new Map<string, ChoiceSession[]>();
  for (const session of sessions) {
    const groupKey = rankingKey(session.category === 'unknown' ? undefined : session.category, session.faces);
    (groupSessions.get(groupKey) ?? groupSessions.set(groupKey, []).get(groupKey)!).push(session);
    (presetSessions.get(session.preset) ?? presetSessions.set(session.preset, []).get(session.preset)!).push(session);
  }
  for (const [key, list] of groupSessions) byGroup[key] = tally(list);
  for (const [key, list] of presetSessions) byPreset[key] = tally(list);

  const leans: Record<string, ParameterLean[]> = {};
  for (const [key, table] of Object.entries(byGroup)) {
    const category = key.split('|')[0];
    const shown = presets.filter(
      (preset) => !preset.categories || category === 'any' || preset.categories.includes(category as VariantCategory),
    );
    leans[key] = leanFor(table, shown);
  }

  const explored = sessions.length
    ? sessions.filter((session) => session.clicks.length > 1 && session.clicks[0].variant !== session.final.variant).length / sessions.length
    : 0;
  const indexed = sessions.filter((session) => typeof session.final.index === 'number');
  const meanWinnerIndex = indexed.length
    ? indexed.reduce((sum, session) => sum + (session.final.index as number), 0) / indexed.length
    : null;

  return {
    records: records.length,
    sessions: sessions.length,
    overall: tally(sessions),
    byPreset,
    byGroup,
    explored,
    meanWinnerIndex,
    leans,
  };
}

/**
 * Порядок ленты из сводки: только для групп, где решений не меньше
 * minSessions, — на пяти кликах порядок менять нельзя.
 */
export function buildRanking(report: ChoiceReport, minSessions: number, now = new Date()): VariantRanking {
  const rankings: Record<string, string[]> = {};
  for (const [key, table] of Object.entries(report.byGroup)) {
    if (table.sessions < minSessions || key.startsWith('any|')) continue;
    rankings[key] = rankWins(table).map((item) => item.id);
  }
  return { updatedAt: now.toISOString().slice(0, 10), minSessions, rankings };
}

/** Текстовый отчёт для консоли. */
export function formatChoiceReport(report: ChoiceReport, minSessions: number): string {
  const lines: string[] = [];
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  lines.push(`Записей: ${report.records}, решений (сеансов): ${report.sessions}`);
  if (!report.sessions) return lines.join('\n');
  lines.push(`Сравнивали, прежде чем выбрать: ${pct(report.explored)} сеансов` +
    (report.meanWinnerIndex !== null ? `; средняя позиция выбранного в ленте: ${report.meanWinnerIndex.toFixed(1)}` : ''));

  lines.push('', 'Всего:');
  for (const item of rankWins(report.overall)) lines.push(`  ${item.id.padEnd(4)} ${String(item.wins).padStart(4)}  ${pct(item.share)}`);

  for (const [key, table] of Object.entries(report.byGroup).sort()) {
    const [category, faces] = key.split('|');
    lines.push('', `${category}, ${faces === 'face' ? 'с лицом' : 'без лица'} — ${table.sessions} решений` +
      (table.sessions < minSessions ? ` (мало данных, порядок не меняется: нужно ${minSessions})` : ''));
    for (const item of rankWins(table).slice(0, 5)) lines.push(`  ${item.id.padEnd(4)} ${String(item.wins).padStart(4)}  ${pct(item.share)}`);
    const leans = (report.leans[key] ?? []).filter((lean) => Math.abs(lean.winners - lean.shown) > 0.02);
    if (leans.length) {
      lines.push('  победители отличаются от среднего:');
      for (const lean of leans) {
        const arrow = lean.winners > lean.shown ? 'выше' : 'ниже';
        lines.push(`    ${lean.label}: ${lean.winners.toFixed(2)} против ${lean.shown.toFixed(2)} (${arrow})`);
      }
    }
  }
  return lines.join('\n');
}
