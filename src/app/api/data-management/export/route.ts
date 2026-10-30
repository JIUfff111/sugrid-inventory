import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import db from '@/lib/db';
import { authErrorResponse, requireSystemAccount } from '@/lib/auth';
import { errorResponse } from '@/lib/api-helpers';
import { DATA_RESOURCES, getResource, resourceWhere, sanitizeRow, toCsv, writeAudit } from '@/lib/data-management';

export async function GET(request: NextRequest) {
  try {
    const actor = await requireSystemAccount();
    const resourceKey = request.nextUrl.searchParams.get('resource')?.trim() || 'all';
    const format = request.nextUrl.searchParams.get('format') === 'csv' ? 'csv' : 'json';
    if (format === 'csv' && resourceKey === 'all') {
      return NextResponse.json(errorResponse('VALIDATION_ERROR', 'CSV 导出需要选择单个数据资源；全量导出请使用 JSON'), { status: 400 });
    }
    const resources = resourceKey === 'all'
      ? Object.values(DATA_RESOURCES)
      : [getResource(resourceKey)].filter(Boolean);
    if (!resources.length) return NextResponse.json(errorResponse('NOT_FOUND', '数据资源不存在'), { status: 404 });
    const exported: Record<string, Record<string, unknown>[]> = {};
    for (const resource of resources) {
      const exportQuery = new URLSearchParams(request.nextUrl.searchParams);
      if (resourceKey === 'all') exportQuery.set('includeDeleted', '1');
      const { whereSql, params } = resourceWhere(resource, exportQuery);
      const rows = db.prepare(`SELECT ${resource.fields.join(',')} FROM ${resource.table} ${whereSql} ORDER BY ${resource.orderBy}`).all(...params) as Record<string, unknown>[];
      exported[resource.key] = rows.map(sanitizeRow);
    }
    const resourceJson = JSON.stringify(exported);
    const dataSummary = {
      resources: Object.keys(exported).length,
      records: Object.values(exported).reduce((sum, rows) => sum + rows.length, 0),
      sha256: createHash('sha256').update(resourceJson, 'utf8').digest('hex'),
    };
    const payload = format === 'csv'
      ? toCsv(exported[resources[0].key] || [])
      : JSON.stringify({ schemaVersion: Number((db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version?: number }).version || 0), exportedAt: new Date().toISOString(), dataSummary, resources: exported }, null, 2);
    const fileName = resourceKey === 'all' ? `sugrid-data-${Date.now()}.${format}` : `sugrid-${resourceKey}-${Date.now()}.${format}`;
    const sha256 = createHash('sha256').update(payload, 'utf8').digest('hex');
    const recordCount = Object.values(exported).reduce((sum: number, rows: Record<string, unknown>[]) => sum + rows.length, 0);
    writeAudit(actor.id, 'export', resourceKey, null, { recordCount, fileName, fileSha256: sha256, format });
    return new NextResponse(payload, {
      status: 200,
      headers: {
        'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'X-Export-SHA256': sha256,
      },
    });
  } catch (error) {
    const failure = authErrorResponse(error);
    if (failure) return failure;
    console.error('GET /api/data-management/export error:', error);
    return NextResponse.json(errorResponse('DATABASE_ERROR', '导出数据失败'), { status: 500 });
  }
}
