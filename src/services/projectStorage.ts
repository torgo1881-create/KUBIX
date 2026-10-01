import { LIMITS } from '../config/limits';

/**
 * Проекты в localStorage: список, переименование, история и автоматическая
 * уборка.
 *
 * Хранятся только настройки и маленькое превью — исходная фотография в
 * localStorage не помещается и не должна там лежать. Хранилище общее на
 * вкладку, места мало, поэтому здесь есть бюджет, вытеснение старых записей
 * и аккуратная обработка QuotaExceededError.
 */

export interface ProjectSettingsSnapshot {
  modeId: string;
  sizeId: string;
  paletteId: string | null;
  distanceMetric: string;
  enforcePieceLimits: boolean;
  shape: string;
  gap: number;
  showGrid: boolean;
  colorSpace: string;
}

export interface ProjectStats {
  cols: number;
  rows: number;
  pieces: number;
  colors: number;
  faces: number;
  durationMs: number;
  qualityScore?: number | null;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  settings: ProjectSettingsSnapshot;
  stats: ProjectStats;
  /** Превью в виде data URL, маленькое. */
  thumbnail?: string;
  /** Имя исходного файла — сама фотография не сохраняется. */
  photoName?: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SaveResult {
  ok: boolean;
  project?: Project;
  /** Сколько проектов пришлось удалить, чтобы освободить место. */
  evicted: number;
  error?: string;
}

const STORAGE_KEY = 'mosaic.projects.v1';

function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    // Приватный режим Safari может кидать прямо на обращении.
    return null;
  }
}

function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: string }).name ?? '';
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

export class ProjectStore {
  private readonly storage: StorageLike | null;
  private readonly now: () => number;

  constructor(storage: StorageLike | null = defaultStorage(), now: () => number = () => Date.now()) {
    this.storage = storage;
    this.now = now;
  }

  /** Доступно ли хранилище: в приватном режиме его может не быть. */
  get available(): boolean {
    return this.storage !== null;
  }

  list(): Project[] {
    if (!this.storage) return [];
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isProject).sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      // Битые данные лучше выбросить, чем падать при каждом старте.
      this.storage.removeItem(STORAGE_KEY);
      return [];
    }
  }

  get(id: string): Project | null {
    return this.list().find((project) => project.id === id) ?? null;
  }

  /** Сохраняет проект, вытесняя старые записи, если не хватает места. */
  save(input: Omit<Project, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): SaveResult {
    if (!this.storage) return { ok: false, evicted: 0, error: 'Хранилище недоступно в этом браузере.' };

    const current = this.now();
    const existing = input.id ? this.get(input.id) : null;

    const project: Project = {
      id: input.id ?? `p-${current.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: input.name.trim() || 'Без названия',
      createdAt: existing?.createdAt ?? current,
      updatedAt: current,
      settings: input.settings,
      stats: input.stats,
      thumbnail: input.thumbnail,
      photoName: input.photoName,
    };

    let projects = [project, ...this.list().filter((item) => item.id !== project.id)];
    projects = this.prune(projects);

    let evicted = 0;
    for (;;) {
      try {
        this.storage.setItem(STORAGE_KEY, JSON.stringify(projects));
        return { ok: true, project, evicted };
      } catch (error) {
        if (!isQuotaError(error) || projects.length <= 1) {
          return {
            ok: false,
            evicted,
            error: isQuotaError(error)
              ? 'В хранилище браузера не осталось места.'
              : 'Не удалось сохранить проект.',
          };
        }
        // Освобождаем место, начиная с самых старых.
        projects.pop();
        evicted++;
      }
    }
  }

  rename(id: string, name: string): Project | null {
    if (!this.storage) return null;
    const projects = this.list();
    const project = projects.find((item) => item.id === id);
    if (!project) return null;

    project.name = name.trim().slice(0, 80) || 'Без названия';
    project.updatedAt = this.now();
    this.write(projects);
    return project;
  }

  remove(id: string): boolean {
    if (!this.storage) return false;
    const projects = this.list();
    const next = projects.filter((project) => project.id !== id);
    if (next.length === projects.length) return false;
    this.write(next);
    return true;
  }

  clear(): void {
    this.storage?.removeItem(STORAGE_KEY);
  }

  /**
   * Уборка: выкидывает просроченные проекты, лишние сверх лимита и всё,
   * что не влезает в бюджет байтов. Вызывается при старте приложения.
   */
  cleanup(): { removed: number; bytes: number } {
    if (!this.storage) return { removed: 0, bytes: 0 };
    const projects = this.list();
    const kept = this.prune(projects);
    if (kept.length !== projects.length) this.write(kept);
    return { removed: projects.length - kept.length, bytes: this.usedBytes(kept) };
  }

  usedBytes(projects: Project[] = this.list()): number {
    return JSON.stringify(projects).length * 2; // UTF-16
  }

  private prune(projects: Project[]): Project[] {
    const cutoff = this.now() - LIMITS.projectTtlDays * 24 * 60 * 60 * 1000;

    let kept = projects
      .filter((project) => project.updatedAt >= cutoff)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, LIMITS.maxProjects);

    while (kept.length > 1 && this.usedBytes(kept) > LIMITS.storageBudgetBytes) {
      kept = kept.slice(0, -1);
    }

    return kept;
  }

  private write(projects: Project[]): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(projects));
    } catch {
      // Молча игнорируем: список в памяти уже актуален, а место кончилось.
    }
  }
}

function isProject(value: unknown): value is Project {
  if (!value || typeof value !== 'object') return false;
  const project = value as Partial<Project>;
  return (
    typeof project.id === 'string' &&
    typeof project.name === 'string' &&
    typeof project.updatedAt === 'number' &&
    typeof project.settings === 'object' &&
    project.settings !== null
  );
}

/** Маленькое превью проекта: канвас уменьшается до заданной стороны. */
export function makeThumbnail(canvas: HTMLCanvasElement, side = LIMITS.thumbnailSide): string {
  const scale = Math.min(1, side / Math.max(canvas.width, canvas.height));
  const target = document.createElement('canvas');
  target.width = Math.max(1, Math.round(canvas.width * scale));
  target.height = Math.max(1, Math.round(canvas.height * scale));

  const context = target.getContext('2d');
  if (context) {
    context.imageSmoothingEnabled = false;
    context.drawImage(canvas, 0, 0, target.width, target.height);
  }
  return target.toDataURL('image/jpeg', 0.7);
}
