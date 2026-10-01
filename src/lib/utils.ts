import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export { clamp, formatBytes, formatNumber, formatRelativeTime } from './format';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
