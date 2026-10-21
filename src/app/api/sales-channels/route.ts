import { requireRole, authErrorResponse } from '@/lib/auth';
/**
 * 销售渠道管理 API
 * GET    /api/sales-channels       获取销售渠道列表
 * POST   /api/sales-channels       新增销售渠道
 * PUT    /api/sales-channels       更新销售渠道
 * DELETE /api/sales-channels       删除销售渠道（逻辑删除）
 */

import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import {
  successResponse,
  errorResponse,
  ErrorCode,
  generateId,
  parsePaginationParams,
  createPaginatedResponse,
  notDeletedCondition
} from '@/lib/api-helpers';

interface SalesChannel {
  id: string;
  channelName: string;
  channelType?: string;
  contactInfo?: string;
  remark?: string;
  status: 'active' | 'inactive';
  usageCount: number;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

function getCurrentUserId() {
  const row = db.prepare('SELECT id FROM users ORDER BY createdAt ASC LIMIT 1').get() as { id: string } | undefined;
  if (!row?.id) throw new Error('系统用户不存在，无法创建销售渠道');
  return row.id;
}

/**
 * GET /api/sales-channels - 获取销售渠道列表
 */
export async function GET(request: NextRequest) {
  try {
    await requireRole('admin');
    const { searchParams } = new URL(request.url);
    const { page, pageSize } = parsePaginationParams(searchParams);
    const search = searchParams.get('search') || '';
    const status = searchParams.get('status') || '';
    
    // 构建查询条件
    let whereConditions = [notDeletedCondition];
    let params: any[] = [];
    
    if (search) {
      whereConditions.push('channelName LIKE ?');
      params.push(`%${search}%`);
    }
    
    if (status) {
      whereConditions.push('status = ?');
      params.push(status);
    }
    
    const whereClause = whereConditions.join(' AND ');
    
    // 查询总数
    const countResult = db.prepare(`
      SELECT COUNT(*) as total FROM sales_channels WHERE ${whereClause}
    `).get(...params) as { total: number };
    
    // 查询列表
    const offset = (page - 1) * pageSize;
    const channels = db.prepare(`
      SELECT * FROM sales_channels 
      WHERE ${whereClause}
      ORDER BY createdAt DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as SalesChannel[];
    
    const paginatedData = createPaginatedResponse(
      channels,
      countResult.total,
      page,
      pageSize
    );
    
    return NextResponse.json(successResponse(paginatedData));
    
  } catch (error: any) {
    const authFailure = authErrorResponse(error);
    if (authFailure) return authFailure;
    console.error('GET /api/sales-channels error:', error);
    return NextResponse.json(
      errorResponse(ErrorCode.DATABASE_ERROR, '获取销售渠道列表失败', error.message),
      { status: 500 }
    );
  }
}

/**
 * POST /api/sales-channels - 新增销售渠道
 */
export async function POST(request: NextRequest) {
  try {
    await requireRole('admin');
    const body = await request.json();
    const { channelName, channelType, contactInfo, remark } = body;
    
    // 验证必填字段
    if (!channelName?.trim()) {
      return NextResponse.json(
        errorResponse(ErrorCode.VALIDATION_ERROR, '渠道名称不能为空'),
        { status: 400 }
      );
    }
    
    // 检查渠道名称是否已存在
    const existingChannel = db.prepare(`
      SELECT id FROM sales_channels WHERE channelName = ? AND ${notDeletedCondition}
    `).get(channelName.trim()) as { id: string } | undefined;
    
    if (existingChannel) {
      return NextResponse.json(
        errorResponse(ErrorCode.DUPLICATE_ENTRY, '渠道名称已存在'),
        { status: 400 }
      );
    }
    
    // 插入新渠道
    const channelId = generateId('channel');
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    
    // Authentication is not wired yet; use the existing operator so the FK remains valid.
    const createdBy = getCurrentUserId();
    
    db.prepare(`
      INSERT INTO sales_channels (
        id, channelName, channelType, contactInfo, remark, 
        status, usageCount, deleted, createdBy, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, 'active', 0, 0, ?, ?, ?)
    `).run(
      channelId,
      channelName.trim(),
      channelType?.trim() || null,
      contactInfo?.trim() || null,
      remark?.trim() || null,
      createdBy,
      now,
      now
    );
    
    // 查询新插入的记录
    const newChannel = db.prepare('SELECT * FROM sales_channels WHERE id = ?').get(channelId);
    
    return NextResponse.json(successResponse(newChannel), { status: 201 });
    
  } catch (error: any) {
    const authFailure = authErrorResponse(error);
    if (authFailure) return authFailure;
    console.error('POST /api/sales-channels error:', error);
    return NextResponse.json(
      errorResponse(ErrorCode.DATABASE_ERROR, '新增销售渠道失败', error.message),
      { status: 500 }
    );
  }
}

/**
 * PUT /api/sales-channels - 更新销售渠道
 */
export async function PUT(request: NextRequest) {
  try {
    await requireRole('admin');
    const body = await request.json();
    const { id, channelName, channelType, contactInfo, remark, status } = body;
    
    // 验证必填字段
    if (!id) {
      return NextResponse.json(
        errorResponse(ErrorCode.VALIDATION_ERROR, '渠道 ID 不能为空'),
        { status: 400 }
      );
    }
    
    if (!channelName?.trim()) {
      return NextResponse.json(
        errorResponse(ErrorCode.VALIDATION_ERROR, '渠道名称不能为空'),
        { status: 400 }
      );
    }
    
    // 检查渠道是否存在
    const existingChannel = db.prepare(`
      SELECT id FROM sales_channels WHERE id = ? AND ${notDeletedCondition}
    `).get(id) as { id: string } | undefined;
    
    if (!existingChannel) {
      return NextResponse.json(
        errorResponse(ErrorCode.NOT_FOUND, '销售渠道不存在'),
        { status: 404 }
      );
    }
    
    // 检查名称是否与其他渠道重复
    const duplicateChannel = db.prepare(`
      SELECT id FROM sales_channels 
      WHERE channelName = ? AND id != ? AND ${notDeletedCondition}
    `).get(channelName.trim(), id) as { id: string } | undefined;
    
    if (duplicateChannel) {
      return NextResponse.json(
        errorResponse(ErrorCode.DUPLICATE_ENTRY, '渠道名称已存在'),
        { status: 400 }
      );
    }
    
    // 更新渠道
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    
    db.prepare(`
      UPDATE sales_channels 
      SET channelName = ?, channelType = ?, contactInfo = ?, 
          remark = ?, status = ?, updatedAt = ?
      WHERE id = ?
    `).run(
      channelName.trim(),
      channelType?.trim() || null,
      contactInfo?.trim() || null,
      remark?.trim() || null,
      status || 'active',
      now,
      id
    );
    
    // 查询更新后的记录
    const updatedChannel = db.prepare('SELECT * FROM sales_channels WHERE id = ?').get(id);
    
    return NextResponse.json(successResponse(updatedChannel));
    
  } catch (error: any) {
    const authFailure = authErrorResponse(error);
    if (authFailure) return authFailure;
    console.error('PUT /api/sales-channels error:', error);
    return NextResponse.json(
      errorResponse(ErrorCode.DATABASE_ERROR, '更新销售渠道失败', error.message),
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/sales-channels - 删除销售渠道（逻辑删除）
 */
export async function DELETE(request: NextRequest) {
  try {
    await requireRole('admin');
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    
    if (!id) {
      return NextResponse.json(
        errorResponse(ErrorCode.VALIDATION_ERROR, '渠道 ID 不能为空'),
        { status: 400 }
      );
    }
    
    // 检查渠道是否存在
    const existingChannel = db.prepare(`
      SELECT id, usageCount FROM sales_channels WHERE id = ? AND ${notDeletedCondition}
    `).get(id) as { id: string; usageCount: number } | undefined;
    
    if (!existingChannel) {
      return NextResponse.json(
        errorResponse(ErrorCode.NOT_FOUND, '销售渠道不存在'),
        { status: 404 }
      );
    }
    
    // 如果已被使用，提示但仍允许删除（只是逻辑删除，历史记录仍保留渠道名称）
    if (existingChannel.usageCount > 0) {
      console.log(`销售渠道 ${id} 已被使用 ${existingChannel.usageCount} 次，执行逻辑删除`);
    }
    
    // 逻辑删除
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    db.prepare('UPDATE sales_channels SET deleted = 1, updatedAt = ? WHERE id = ?').run(now, id);
    
    return NextResponse.json(successResponse({ id }));
    
  } catch (error: any) {
    const authFailure = authErrorResponse(error);
    if (authFailure) return authFailure;
    console.error('DELETE /api/sales-channels error:', error);
    return NextResponse.json(
      errorResponse(ErrorCode.DATABASE_ERROR, '删除销售渠道失败', error.message),
      { status: 500 }
    );
  }
}
