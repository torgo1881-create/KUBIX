'use client';

import * as React from 'react';

import { generateVariant, type Variant } from '@/algorithms/variants/variantGenerator';
import { buildPresetPalette } from '@/config/paletteData';
import { getProcessingProfile } from '@/config/processingProfiles';
import { getPreset, presetAspect, PRODUCT_PRESETS, type ProductPreset } from '@/config/productPresets';
import {
  SHOP_DEFAULT_FOCUS,
  SHOP_DEFAULT_PRESET_ID,
  SHOP_STEPS,
  SHOP_TOAST_MS,
  shopVariantPresets,
} from '@/config/shop';
import type { VariantPreset } from '@/config/variants';
import { coverCropRect, cropToCanvas, sameCropRect } from '@/lib/cropRect';
import { loadImageFile, releaseImage } from '@/lib/imageFile';
import { createSamplePhoto } from '@/lib/samplePhoto';
import { createMosaicWorker } from '@/lib/workerFactory';
import { setWorkerFactory } from '@/services/mosaicRunner';
import type { CropRect, MosaicGrid, SourceImage } from '@/types/mosaic';

import { Generator } from './Generator';
import { Landing } from './Landing';
import { ShopHeader } from './ShopHeader';
import { useKeyedJobs } from './useKeyedJobs';

interface ShopPhoto {
  image: SourceImage;
  /** Растёт с каждым новым фото — по нему сбрасываются кадр и кэш расчётов. */
  version: number;
  /** Уменьшенная копия для панели «Сейчас загружено». */
  thumbnail: HTMLCanvasElement;
}

/** Кадр пользователя помнит, к какому фото относится. */
interface SavedCrop {
  version: number;
  rect: CropRect;
}

/** Превью наборов мелкие — их пять на странице, и считаются они на каждое фото. */
const PREVIEW_SOURCE_SIZE = 512;
const PREVIEW_OUTPUT_SIZE = 256;
/** Кадр для генератора и картинка варианта: хватает и для экрана, и для PDF. */
const CROP_SOURCE_SIZE = 1536;
const VARIANT_OUTPUT_SIZE = 1024;
const HERO_PHOTO_SIZE = 760;
const THUMBNAIL_SIZE = 640;
const CROP_DEBOUNCE_MS = 200;

const PREVIEW_ORDER = [
  SHOP_DEFAULT_PRESET_ID,
  ...PRODUCT_PRESETS.map((preset) => preset.id).filter((id) => id !== SHOP_DEFAULT_PRESET_ID),
];

function toShopPhoto(image: SourceImage, version: number): ShopPhoto {
  return {
    image,
    version,
    thumbnail: cropToCanvas(image.element, { x: 0, y: 0, width: image.width, height: image.height }, THUMBNAIL_SIZE),
  };
}

/** Один вариант существующим генератором — с палитрой, сеткой и профилем набора. */
function buildVariant(
  variant: VariantPreset,
  product: ProductPreset,
  source: HTMLCanvasElement,
  targetOutputSize: number,
): Promise<Variant> {
  const profile = getProcessingProfile(product.processingProfile);
  return generateVariant(variant, {
    source,
    cols: product.width,
    rows: product.height,
    palette: buildPresetPalette(product),
    modeId: profile.modeId,
    distanceMetric: profile.distanceMetric,
    category: product.category,
    enforcePieceLimits: profile.enforcePieceLimits,
    targetOutputSize,
  });
}

/**
 * Витрина Kubix: лендинг и пятишаговый генератор на одной странице.
 *
 * Здесь живут состояние и расчёты; разметка — в Landing и Generator. Всё
 * считается в браузере существующим алгоритмом, фото никуда не уходит.
 */
export function KubixShop() {
  const [screen, setScreen] = React.useState<'landing' | 'app'>('landing');
  const [step, setStep] = React.useState(1);
  const [presetId, setPresetId] = React.useState(SHOP_DEFAULT_PRESET_ID);
  const [photo, setPhoto] = React.useState<ShopPhoto | null>(null);
  const [savedCrop, setSavedCrop] = React.useState<SavedCrop | null>(null);
  const [chosenVariantId, setChosenVariantId] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [cartCount, setCartCount] = React.useState(0);
  const [toast, setToast] = React.useState('');

  const photoRef = React.useRef<ShopPhoto | null>(null);
  const versionRef = React.useRef(0);
  const toastTimer = React.useRef<ReturnType<typeof setTimeout>>();
  const cropTimer = React.useRef<ReturnType<typeof setTimeout>>();
  const pendingCrop = React.useRef<CropRect | null>(null);

  /* --- сообщения ---------------------------------------------------------- */

  const showToast = React.useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), SHOP_TOAST_MS);
  }, []);

  /* --- инициализация: воркер и пример фото -------------------------------- */

  React.useEffect(() => {
    setWorkerFactory(() => createMosaicWorker());
    return () => setWorkerFactory(null);
  }, []);

  React.useEffect(() => {
    if (!photoRef.current) {
      photoRef.current = toShopPhoto(createSamplePhoto(), 0);
      setPhoto(photoRef.current);
    }
    return () => {
      clearTimeout(toastTimer.current);
      clearTimeout(cropTimer.current);
    };
  }, []);

  React.useEffect(() => () => releaseImage(photoRef.current?.image), []);

  /* --- набор, кадр, лента вариантов ---------------------------------------- */

  const product = getPreset(presetId);
  const aspect = presetAspect(product);
  const lineup = React.useMemo(() => shopVariantPresets(product.category), [product.category]);
  const variantId = lineup.some((item) => item.id === chosenVariantId) ? (chosenVariantId as string) : lineup[0].id;

  // Сохранённый кадр годится, только если он от этого фото и этих пропорций.
  const crop = React.useMemo(() => {
    if (!photo) return null;
    const saved = savedCrop && savedCrop.version === photo.version ? savedCrop.rect : null;
    if (saved && Math.abs(saved.width / saved.height - aspect) < 0.02) return saved;
    return coverCropRect(photo.image.width, photo.image.height, aspect, SHOP_DEFAULT_FOCUS.x, SHOP_DEFAULT_FOCUS.y);
  }, [aspect, photo, savedCrop]);

  const cropped = React.useMemo(
    () => (photo && crop ? cropToCanvas(photo.image.element, crop, CROP_SOURCE_SIZE) : null),
    [crop, photo],
  );

  const latest = React.useRef({ aspect, crop, version: photo?.version ?? -1 });
  latest.current = { aspect, crop, version: photo?.version ?? -1 };

  const commitCrop = React.useCallback(() => {
    clearTimeout(cropTimer.current);
    const rect = pendingCrop.current;
    pendingCrop.current = null;
    const current = latest.current;
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    // Пока кроппер не измерил себя, он сообщает кадр на всё фото — такой
    // кадр чужих пропорций не принимаем.
    if (Math.abs(rect.width / rect.height - current.aspect) >= 0.02) return;
    if (current.crop && sameCropRect(rect, current.crop)) return;
    setSavedCrop({ version: current.version, rect });
  }, []);

  // Кроппер сообщает кадр на каждое движение; пересчёт — когда рука остановилась.
  const handleCropChange = React.useCallback(
    (rect: CropRect) => {
      pendingCrop.current = rect;
      clearTimeout(cropTimer.current);
      cropTimer.current = setTimeout(commitCrop, CROP_DEBOUNCE_MS);
    },
    [commitCrop],
  );

  /* --- превью наборов: hero, каталог, шаг 1 -------------------------------- */

  const previews = useKeyedJobs<MosaicGrid>(
    photo ? `photo:${photo.version}` : null,
    PREVIEW_ORDER,
    async (id) => {
      const preset = getPreset(id);
      const image = (photo as ShopPhoto).image;
      const rect = coverCropRect(
        image.width,
        image.height,
        presetAspect(preset),
        SHOP_DEFAULT_FOCUS.x,
        SHOP_DEFAULT_FOCUS.y,
      );
      const source = cropToCanvas(image.element, rect, PREVIEW_SOURCE_SIZE);
      const variant = await buildVariant(shopVariantPresets(preset.category)[0], preset, source, PREVIEW_OUTPUT_SIZE);
      return variant.mosaic.grid;
    },
    showToast,
  );

  const heroPreset = getPreset(SHOP_DEFAULT_PRESET_ID);
  const heroPhoto = React.useMemo(() => {
    if (!photo) return null;
    const { image } = photo;
    const rect = coverCropRect(
      image.width,
      image.height,
      presetAspect(heroPreset),
      SHOP_DEFAULT_FOCUS.x,
      SHOP_DEFAULT_FOCUS.y,
    );
    return cropToCanvas(image.element, rect, HERO_PHOTO_SIZE);
  }, [heroPreset, photo]);

  /* --- варианты текущего кадра ---------------------------------------------- */

  const needVariants = screen === 'app' && step >= 3 && photo !== null && crop !== null;
  const variantKey = needVariants
    ? [photo.version, product.id, ...[crop.x, crop.y, crop.width, crop.height].map((value) => value.toFixed(1))].join('|')
    : null;
  // На шаге «Вариант» нужна вся лента, на остальных — только выбранный.
  const wantedVariants =
    step === 4 ? [variantId, ...lineup.map((item) => item.id).filter((id) => id !== variantId)] : [variantId];

  const variants = useKeyedJobs<Variant>(
    variantKey,
    wantedVariants,
    (id) =>
      buildVariant(
        lineup.find((item) => item.id === id) as VariantPreset,
        product,
        cropped as HTMLCanvasElement,
        VARIANT_OUTPUT_SIZE,
      ),
    showToast,
  );

  const bestVariantId = React.useMemo(() => {
    if (!lineup.every((item) => variants.results.has(item.id))) return null;
    let best: Variant | null = null;
    for (const item of lineup) {
      const candidate = variants.results.get(item.id) as Variant;
      if (!best || candidate.qualityScore.total > best.qualityScore.total) best = candidate;
    }
    return best?.id ?? null;
  }, [lineup, variants.results]);

  /* --- переходы -------------------------------------------------------------- */

  const scrollTop = () => window.scrollTo({ top: 0 });

  const goStep = React.useCallback(
    (next: number) => {
      commitCrop();
      setStep(Math.min(SHOP_STEPS.length, Math.max(1, next)));
      scrollTop();
    },
    [commitCrop],
  );

  const openApp = React.useCallback(
    (nextStep: number) => {
      setScreen('app');
      goStep(nextStep);
    },
    [goStep],
  );

  const goLanding = React.useCallback(() => {
    commitCrop();
    setScreen('landing');
    scrollTop();
  }, [commitCrop]);

  /* --- действия ---------------------------------------------------------------- */

  const handleFile = React.useCallback(
    async (file: File) => {
      setUploading(true);
      try {
        const image = await loadImageFile(file);
        releaseImage(photoRef.current?.image);
        photoRef.current = toShopPhoto(image, ++versionRef.current);
        pendingCrop.current = null;
        setPhoto(photoRef.current);
        // В генераторе новое фото сразу ведёт к кадрированию; на лендинге
        // остаёмся на месте — обновятся hero, каталог и примерка.
        if (screen === 'app') goStep(3);
      } catch (cause) {
        showToast(cause instanceof Error ? cause.message : 'Не получилось открыть файл.');
      } finally {
        setUploading(false);
      }
    },
    [goStep, screen, showToast],
  );

  const handleBuy = React.useCallback(
    (preset: ProductPreset) => {
      setCartCount((count) => count + 1);
      showToast(`${preset.name} добавлен в корзину`);
    },
    [showToast],
  );

  const handleTry = React.useCallback(
    (preset: ProductPreset) => {
      setPresetId(preset.id);
      openApp(2);
    },
    [openApp],
  );

  const handleBoxCode = React.useCallback(
    (code: string) => {
      if (!code) {
        showToast('Введи код с карточки внутри коробки');
        return;
      }
      openApp(2);
    },
    [openApp, showToast],
  );

  /* --- разметка ------------------------------------------------------------------ */

  return (
    <div
      // В генераторе колонка тянется на весь экран, чтобы панель «Назад / Дальше» стояла у нижнего края.
      className={screen === 'app' ? 'flex min-h-screen flex-col bg-background text-ink' : 'min-h-screen bg-background text-ink'}
      data-screen={screen}
    >
      <ShopHeader
        landing={screen === 'landing'}
        cartCount={cartCount}
        onHome={goLanding}
        onUpload={() => openApp(2)}
      />

      {screen === 'landing' ? (
        <Landing
          previews={previews.results}
          heroGrid={previews.results.get(SHOP_DEFAULT_PRESET_ID)}
          heroPhoto={heroPhoto}
          heroPresetName={heroPreset.name}
          photoName={photo?.image.name ?? ''}
          uploading={uploading}
          onFile={handleFile}
          onError={showToast}
          onBuy={handleBuy}
          onTry={handleTry}
          onStart={() => openApp(2)}
          onBoxCode={handleBoxCode}
        />
      ) : (
        <Generator
          step={step}
          onStep={goStep}
          product={product}
          previews={previews.results}
          onSelectPreset={(preset) => setPresetId(preset.id)}
          image={photo?.image ?? null}
          thumbnail={photo?.thumbnail ?? null}
          uploading={uploading}
          onFile={handleFile}
          onError={showToast}
          crop={crop}
          cropped={cropped}
          onCropChange={handleCropChange}
          lineup={lineup}
          variants={variants.results}
          variantId={variantId}
          bestVariantId={bestVariantId}
          onSelectVariant={setChosenVariantId}
        />
      )}

      {toast ? (
        <div
          role="status"
          data-toast
          className="fixed bottom-[90px] left-1/2 z-40 max-w-[min(90vw,520px)] -translate-x-1/2 rounded-[14px] bg-ink px-5 py-3 text-center text-sm font-bold text-background"
        >
          {toast}
        </div>
      ) : null}
    </div>
  );
}
