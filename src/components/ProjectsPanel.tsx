'use client';

import { Check, Pencil, Share2, Trash2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Project } from '@/services/projectStorage';

interface ProjectsPanelProps {
  projects: Project[];
  currentId: string | null;
  storageAvailable: boolean;
  onOpen: (project: Project) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onShare: (project: Project) => void;
}

/** История последних проектов: открыть, переименовать, поделиться, удалить. */
export function ProjectsPanel({
  projects,
  currentId,
  storageAvailable,
  onOpen,
  onRename,
  onDelete,
  onShare,
}: ProjectsPanelProps) {
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState('');

  if (!storageAvailable) {
    return (
      <p className="text-sm text-muted-foreground">
        Браузер не даёт сохранять проекты — скорее всего, включён приватный режим. Мозаика работает,
        но история не сохранится.
      </p>
    );
  }

  if (projects.length === 0) {
    return <p className="text-sm text-muted-foreground">Здесь появятся последние проекты.</p>;
  }

  const commit = (id: string) => {
    onRename(id, draft);
    setEditingId(null);
  };

  return (
    <ul className="space-y-2" data-testid="projects">
      {projects.map((project) => (
        <li
          key={project.id}
          data-project={project.id}
          className={cn(
            'flex items-center gap-3 rounded-md border p-2',
            currentId === project.id ? 'border-primary bg-primary/5' : 'border-border',
          )}
        >
          {project.thumbnail ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={project.thumbnail}
              alt=""
              className="size-12 shrink-0 rounded-sm border border-border object-cover"
              style={{ imageRendering: 'pixelated' }}
            />
          ) : (
            <span className="size-12 shrink-0 rounded-sm border border-border bg-secondary" />
          )}

          <div className="min-w-0 flex-1">
            {editingId === project.id ? (
              <input
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commit(project.id);
                  if (event.key === 'Escape') setEditingId(null);
                }}
                onBlur={() => commit(project.id)}
                data-rename-input
                className="w-full rounded-sm border border-input bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            ) : (
              <button
                type="button"
                onClick={() => onOpen(project)}
                className="block w-full truncate text-left text-sm hover:underline"
                data-open
              >
                {project.name}
              </button>
            )}
            <span className="block truncate font-mono text-[11px] text-muted-foreground">
              {project.stats.cols}×{project.stats.rows} · {project.stats.colors} цветов ·{' '}
              {formatRelativeTime(project.updatedAt)}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Переименовать"
              data-action="rename"
              onClick={() => {
                setEditingId(project.id);
                setDraft(project.name);
              }}
            >
              {editingId === project.id ? <Check /> : <Pencil />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Поделиться"
              data-action="share"
              onClick={() => onShare(project)}
            >
              <Share2 />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Удалить"
              data-action="delete"
              onClick={() => onDelete(project.id)}
            >
              <Trash2 />
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
