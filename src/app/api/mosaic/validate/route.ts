import { PALETTE_IDS } from '@/config/paletteData';
import { handleValidateRequest } from '@/server/handlers';

/**
 * Серверная проверка параметров генерации: whitelist размеров, режимов и
 * палитр, лимиты на файл и бюджет памяти, ограничение частоты запросов.
 * Считает по-прежнему браузер — сервер не пускает к работе заведомо
 * невозможные задачи.
 */
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const result = await handleValidateRequest(request, { allowedPaletteIds: PALETTE_IDS });
  return Response.json(result.body, { status: result.status, headers: result.headers });
}
