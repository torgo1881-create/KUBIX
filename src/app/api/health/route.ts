/**
 * Проверка живости для хостинга: Railway опрашивает этот путь после
 * деплоя и при рестартах. Ничего не считает — только отвечает.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return Response.json({
    ok: true,
    service: 'photo-mosaic',
    version: process.env.npm_package_version ?? null,
    time: new Date().toISOString(),
  });
}
