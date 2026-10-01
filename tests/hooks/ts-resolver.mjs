/**
 * Разрешение относительных импортов без расширения (`./lab` → `./lab.ts`),
 * чтобы node --experimental-strip-types мог запускать модули из src/ напрямую.
 */
export async function resolve(specifier, context, next) {
  // Node требует import-атрибут для JSON, а сборщики Next — нет.
  // Проставляем его сами, чтобы src/ работал и там, и там.
  if (specifier.endsWith('.json')) {
    const resolved = await next(specifier, context);
    return { ...resolved, importAttributes: { type: 'json' } };
  }

  if (specifier.startsWith('.') && !/\.[cm]?[jt]s$|\.json$/.test(specifier)) {
    try {
      return await next(specifier + '.ts', context);
    } catch {
      // падаем в обычное разрешение ниже
    }
  }
  return next(specifier, context);
}
