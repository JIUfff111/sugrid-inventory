import { existsSync } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const responseHeaders = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
};

export async function GET() {
  const databasePath = path.resolve(
    /*turbopackIgnore: true*/ process.env.INVENTORY_DB_PATH || path.join(process.cwd(), 'data', 'inventory.db'),
  );

  if (!existsSync(/*turbopackIgnore: true*/ databasePath)) {
    return NextResponse.json(
      { status: 'not_ready', database: 'missing', version: process.env.SUGRID_APP_VERSION || 'unknown' },
      { status: 503, headers: responseHeaders },
    );
  }

  try {
    const { getDatabase } = await import('@/lib/db');
    getDatabase().prepare('SELECT 1').get();

    return NextResponse.json(
      {
        status: 'ok',
        database: 'ready',
        version: process.env.SUGRID_APP_VERSION || 'unknown',
        serviceInstance: process.env.SUGRID_SERVICE_INSTANCE || null,
      },
      { headers: responseHeaders },
    );
  } catch {
    return NextResponse.json(
      { status: 'not_ready', database: 'unavailable', version: process.env.SUGRID_APP_VERSION || 'unknown' },
      { status: 503, headers: responseHeaders },
    );
  }
}
