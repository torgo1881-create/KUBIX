import { PALETTE_IDS } from '@/config/paletteData';
import { handleLimitsRequest } from '@/server/handlers';

/** Публичные лимиты: клиент показывает их пользователю до загрузки файла. */
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const result = handleLimitsRequest(request, { allowedPaletteIds: PALETTE_IDS });
  return Response.json(result.body, { status: result.status, headers: result.headers });
}
