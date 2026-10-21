import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { authErrorResponse, requireRole, requireUser } from '@/lib/auth';
import { errorResponse, formatDateTime, generateId, successResponse } from '@/lib/api-helpers';

function failure(error: unknown) {
  return authErrorResponse(error) || NextResponse.json(errorResponse('VALIDATION_ERROR', error instanceof Error ? error.message : '状态保存失败'), { status: 400 });
}
function definition(body: Record<string, unknown>, current: Record<string, unknown> = {}) {
  const name = String(body.name ?? current.name ?? '').trim();
  const color = String(body.color ?? current.color ?? '#2563eb');
  if (!name || name.length > 30) throw new Error('状态名称应为 1-30 个字符');
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('请选择有效的状态颜色');
  for (const key of ['allowStockOperations', 'isActive']) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean' && body[key] !== 0 && body[key] !== 1) throw new Error('状态开关格式不正确');
  }
  return { name, color, allowStockOperations: Number(Boolean(body.allowStockOperations ?? current.allowStockOperations ?? false)), isActive: Number(Boolean(body.isActive ?? current.isActive ?? true)) };
}
export async function GET(request: NextRequest) {
  try {
    await requireUser();
    const items = db.prepare(`SELECT * FROM inventory_status_definitions ${request.nextUrl.searchParams.get('active') === '1' ? 'WHERE isActive = 1' : ''} ORDER BY createdAt,id`).all();
    return NextResponse.json(successResponse({ items }));
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  try {
    const user = await requireRole('admin');
    const value = definition(await request.json());
    const id = generateId('status'); const now = formatDateTime();
    db.prepare('INSERT INTO inventory_status_definitions(id,name,color,allowStockOperations,isActive,createdBy,updatedBy,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id,value.name,value.color,value.allowStockOperations,value.isActive,user.id,user.id,now,now);
    return NextResponse.json(successResponse(db.prepare('SELECT * FROM inventory_status_definitions WHERE id = ?').get(id)), { status: 201 });
  } catch (error) { return failure(error); }
}
export async function PATCH(request: NextRequest) {
  try {
    const user = await requireRole('admin'); const body = await request.json(); const id = String(body.id || '').trim();
    const current = db.prepare('SELECT * FROM inventory_status_definitions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!current) throw new Error('状态定义不存在');
    const value = definition(body,current);
    db.prepare('UPDATE inventory_status_definitions SET name = ?, color = ?, allowStockOperations = ?, isActive = ?, updatedBy = ?, updatedAt = ? WHERE id = ?')
      .run(value.name,value.color,value.allowStockOperations,value.isActive,user.id,formatDateTime(),id);
    return NextResponse.json(successResponse(db.prepare('SELECT * FROM inventory_status_definitions WHERE id = ?').get(id)));
  } catch (error) { return failure(error); }
}
