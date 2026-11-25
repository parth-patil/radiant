export const THUMBNAIL_LEVELS = [32, 64, 128] as const;
export type ThumbnailLevel = typeof THUMBNAIL_LEVELS[number];
export type ThumbnailLevels<T> = Partial<Record<ThumbnailLevel, T>>;
