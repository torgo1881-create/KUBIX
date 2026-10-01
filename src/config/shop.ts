import type { MosaicRenderOptions } from '../types/mosaic';
import { VARIANT_PRESETS, type VariantCategory, type VariantPreset } from './variants';

/**
 * Витрина Kubix: тексты лендинга и генератора, состав ленты вариантов и
 * то, как мозаика рисуется на тёмной подложке. Алгоритмов здесь нет —
 * только то, что видит покупатель.
 */

/** Набор, на котором построены hero и примерка. */
export const SHOP_DEFAULT_PRESET_ID = 'color-m';

/**
 * Четыре обработки, которые видит покупатель. Остальные варианты из
 * VARIANT_PRESETS остаются в /lab. «Как в наборе» (G) снят с монохромного
 * эталона, поэтому для цветных наборов его место занимает «Чёткие черты» (N).
 */
export const SHOP_VARIANT_IDS: Record<VariantCategory, string[]> = {
  classic: ['G', 'A', 'I', 'C'],
  color: ['N', 'A', 'I', 'C'],
};

export function shopVariantPresets(category: VariantCategory): VariantPreset[] {
  return SHOP_VARIANT_IDS[category]
    .map((id) => VARIANT_PRESETS.find((preset) => preset.id === id))
    .filter((preset): preset is VariantPreset => Boolean(preset));
}

/** Детали на тёмной подложке с зазором — так мозаика выглядит на витрине. */
export const SHOP_MOSAIC_RENDER: Omit<MosaicRenderOptions, 'cellSize'> = {
  shape: 'square',
  gap: 0.1,
  background: '#14302F',
};

/** Центр кадра по умолчанию: чуть выше середины, где обычно лицо. */
export const SHOP_DEFAULT_FOCUS = { x: 0.5, y: 0.42 };

/** Предел масштаба при кадрировании в генераторе. */
export const SHOP_CROP_MAX_ZOOM = 3;

export interface ShopStep {
  label: string;
  title: string;
  subtitle: string;
  /** Подпись кнопки «дальше»; у последнего шага её нет. */
  next: string | null;
}

export const SHOP_STEPS: ShopStep[] = [
  {
    label: 'Набор',
    title: 'Выбери набор',
    subtitle: 'От набора зависят размер картины, сетка и цвета деталей.',
    next: 'Дальше: фото',
  },
  {
    label: 'Фото',
    title: 'Загрузи фото',
    subtitle: 'Лучше всего подходит портрет при дневном свете, лицо крупно.',
    next: 'Дальше: кадр',
  },
  {
    label: 'Кадр',
    title: 'Подгони кадр',
    subtitle: 'Перетаскивай фото и меняй масштаб. Справа видно, как это будет выглядеть в деталях.',
    next: 'Показать варианты',
  },
  {
    label: 'Вариант',
    title: 'Выбери вариант',
    subtitle: 'Одна фотография, четыре обработки. Выбирай глазами: оценка только подсказка.',
    next: 'Собирать этот вариант',
  },
  {
    label: 'Сборка',
    title: 'Собирай по блокам',
    subtitle: 'Иди блок за блоком. Цифра в клетке — номер цвета из легенды.',
    next: null,
  },
];

export const SHOP_HOW_IT_WORKS: { title: string; text: string }[] = [
  {
    title: 'Выбери набор',
    text: 'Classic в оттенках серого или Color с тёплыми тонами. От 51×51 до 76×76 см.',
  },
  {
    title: 'Загрузи фото в генератор',
    text: 'Код для сборки лежит в коробке. А примерить можно бесплатно, ещё до покупки.',
  },
  {
    title: 'Получи инструкцию',
    text: 'Схема по блокам с номерами цветов, на экране или в PDF. Надоело фото — пересобери с новым.',
  },
];

export const SHOP_GIFT_CARDS: { title: string; text: string; tone: 'peach' | 'mint' | 'surface' }[] = [
  {
    title: 'Любое изображение',
    text: 'Портрет, питомец, пейзаж — генератор подберёт тона под палитру набора.',
    tone: 'peach',
  },
  {
    title: '1 набор — ∞ фото',
    text: 'Детали те же, меняется только схема. Разбери и собери новую картину.',
    tone: 'mint',
  },
  {
    title: 'Вместе веселее',
    text: 'Блоки 8×8 удобно делить: каждый собирает свой кусок картины.',
    tone: 'surface',
  },
];

export const SHOP_FAQ: { question: string; answer: string }[] = [
  {
    question: 'Почему деталей в коробке больше, чем клеток?',
    answer:
      'Запаса примерно в полтора раза больше: любая фотография где-то перекошена в один цвет, и без запаса картину было бы не собрать.',
  },
  {
    question: 'Какое фото подойдёт лучше всего?',
    answer:
      'Портрет при дневном свете, лицо крупно. Мелкие детали на дальнем плане в сетке 64×64 почти не читаются.',
  },
  {
    question: 'Можно пересобрать с другим фото?',
    answer: 'Да. Детали те же, меняется только схема: загрузи новое фото и получи новую инструкцию.',
  },
  {
    question: 'Фото куда-то отправляется?',
    answer: 'Нет, превью и схема считаются прямо в браузере.',
  },
];

/** Сколько живёт всплывающее сообщение, мс. */
export const SHOP_TOAST_MS = 2800;
