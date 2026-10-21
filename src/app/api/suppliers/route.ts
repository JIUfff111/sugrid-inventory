import { requireRole, authErrorResponse } from '@/lib/auth';
/**
 * 供应商管理 API
 * GET    /api/suppliers       获取供应商列表
 * POST   /api/suppliers       新增供应商
 * PUT    /api/suppliers/:id   更新供应商
 * DELETE /api/suppliers/:id   删除供应商（逻辑删除）
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

interface Supplier {
  id: string;
  supplierName: string;
  contactPerson?: string;
  contactPhone?: string;
  address?: string;
  remark?: string;
  status: 'active' | 'inactive';
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * GET /api/suppliers - 获取供应商列表（支持分页和搜索）
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
      whereConditions.push('(supplierName LIKE ? OR contactPerson LIKE ? OR contactPhone LIKE ?)');
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern, searchPattern);
    }
    
    if (status) {
      whereConditions.push('status = ?');
      params.push(status);
    }
    
    const whereClause = whereConditions.join(' AND ');
    
    // 查询总数
    const countResult = db.prepare(`
      SELECT COUNT(*) as total FROM suppliers WHERE ${whereClause}
    `).get(...params) as { total: number };
    
    // 查询列表
    const offset = (page - 1) * pageSize;
    const suppliers = db.prepare(`
      SELECT * FROM suppliers 
      WHERE ${whereClause}
      ORDER BY createdAt DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as Supplier[];
    
    const paginatedData = createPaginatedResponse(
      suppliers,
      countResult.total,
      page,
      pageSize
    );
    
    return NextResponse.json(successResponse(paginatedData));
    
  } catch (error: any) {
    const authFailure = authErrorResponse(error);
    if (authFailure) return authFailure;
    console.error('GET /api/suppliers error:', error);
    return NextResponse.json(
      errorResponse(ErrorCode.DATABASE_ERROR, '获取供应商列表失败', error.message),
      { status: 500 }
    );
  }
}

/**
 * POST /api/suppliers - 新增供应商
 */
export async function POST(request: NextRequest) {
  try {
    await requireRole('admin');
    const body = await request.json();
    const { supplierName, contactPerson, contactPhone, address, remark } = body;
    
    // 验证必填字段
    if (!supplierName?.trim()) {
      return NextResponse.json(
        errorResponse(ErrorCode.VALIDATION_ERROR, '供应商名称不能为空'),
        { status: 400 }
      );
    }
    
    // 检查供应商名称是否已存在
    const existingSupplier = db.prepare(`
      SELECT id FROM suppliers WHERE supplierName = ? AND ${notDeletedCondition}
    `).get(supplierName.trim()) as { id: string } | undefined;
    
    if (existingSupplier) {
      return NextResponse.json(
        errorResponse(ErrorCode.DUPLICATE_ENTRY, '供应商名称已存在'),
        { status: 400 }
      );
    }
    
    // 插入新供应商
    const supplierId = generateId('supplier');
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    
    // 使用 users 表中的真实用户 ID（满足外键约束）
    const firstUser = db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string } | undefined;
    const createdBy = firstUser?.id || 'user_admin';
    
    db.prepare(`
      INSERT INTO suppliers (
        id, supplierName, contactPerson, contactPhone, address, remark, 
        status, deleted, createdBy, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)
    `).run(
      supplierId,
      supplierName.trim(),
      contactPerson?.trim() || null,
      contactPhone?.trim() || null,
      address?.trim() || null,
      remark?.trim() || null,
      createdBy,
      now,
      now
    );
    
    // 查询新插入的记录
    const newSupplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId);
    
    return NextResponse.json(successResponse(newSupplier), { status: 201 });
    
  } catch (error: any) {
    const authFailure = authErrorResponse(error);
    if (authFailure) return authFailure;
    console.error('POST /api/suppliers error:', error);
    return NextResponse.json(
      errorResponse(ErrorCode.DATABASE_ERROR, '新增供应商失败', error.message),
      { status: 500 }
    );
  }
}

/**
 * PUT /api/suppliers - 更新供应商
 */
export async function PUT(request: NextRequest) {
  try {
    await requireRole('admin');
    const body = await request.json();
    const { id, supplierName, contactPerson, contactPhone, address, remark, status } = body;
    
    // 验证必填字段
    if (!id) {
      return NextResponse.json(
        errorResponse(ErrorCode.VALIDATION_ERROR, '供应商 ID 不能为空'),
        { status: 400 }
      );
    }
    
    if (!supplierName?.trim()) {
      return NextResponse.json(
        errorResponse(ErrorCode.VALIDATION_ERROR, '供应商名称不能为空'),
        { status: 400 }
      );
    }
    
    // 检查供应商是否存在
    const existingSupplier = db.prepare(`
      SELECT id FROM suppliers WHERE id = ? AND ${notDeletedCondition}
    `).get(id) as { id: string } | undefined;
    
    if (!existingSupplier) {
      return NextResponse.json(
        errorResponse(ErrorCode.SUPPLIER_NOT_FOUND, '供应商不存在'),
        { status: 404 }
      );
    }
    
    // 检查名称是否与其他供应商重复
    const duplicateSupplier = db.prepare(`
      SELECT id FROM suppliers 
      WHERE supplierName = ? AND id != ? AND ${notDeletedCondition}
    `).get(supplierName.trim(), id) as { id: string } | undefined;
    
    if (duplicateSupplier) {
      return NextResponse.json(
        errorResponse(ErrorCode.DUPLICATE_ENTRY, '供应商名称已存在'),
        { status: 400 }
      );
    }
    
    // 更新供应商
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    
    db.prepare(`
      UPDATE suppliers 
      SET supplierName = ?, contactPerson = ?, contactPhone = ?, 
          address = ?, remark = ?, status = ?, updatedAt = ?
      WHERE id = ?
    `).run(
      supplierName.trim(),
      contactPerson?.trim() || null,
      contactPhone?.trim() || null,
      address?.trim() || null,
      remark?.trim() || null,
      status || 'active',
      now,
      id
    );
    
    // 查询更新后的记录
    const updatedSupplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
    
    return NextResponse.json(successResponse(updatedSupplier));
    
  } catch (error: any) {
    const authFailure = authErrorResponse(error);
    if (authFailure) return authFailure;
    console.error('PUT /api/suppliers error:', error);
    return NextResponse.json(
      errorResponse(ErrorCode.DATABASE_ERROR, '更新供应商失败', error.message),
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/suppliers - 删除供应商（逻辑删除）
 */
export async function DELETE(request: NextRequest) {
  try {
    await requireRole('admin');
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    
    if (!id) {
      return NextResponse.json(
        errorResponse(ErrorCode.VALIDATION_ERROR, '供应商 ID 不能为空'),
        { status: 400 }
      );
    }
    
    // 检查供应商是否存在
    const existingSupplier = db.prepare(`
      SELECT id FROM suppliers WHERE id = ? AND ${notDeletedCondition}
    `).get(id) as { id: string } | undefined;
    
    if (!existingSupplier) {
      return NextResponse.json(
        errorResponse(ErrorCode.SUPPLIER_NOT_FOUND, '供应商不存在'),
        { status: 404 }
      );
    }
    
    // 检查是否有关联的采购单
    const purchaseCount = db.prepare(`
      SELECT COUNT(*) as count FROM purchase_orders 
      WHERE supplierId = ? AND ${notDeletedCondition}
    `).get(id) as { count: number };
    
    if (purchaseCount.count > 0) {
      return NextResponse.json(
        errorResponse(
          ErrorCode.CANNOT_DELETE_IN_USE,
          `该供应商已关联 ${purchaseCount.count} 个采购单，无法删除`
        ),
        { status: 400 }
      );
    }
    
    // 逻辑删除
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    db.prepare('UPDATE suppliers SET deleted = 1, updatedAt = ? WHERE id = ?').run(now, id);
    
    return NextResponse.json(successResponse({ id }));
    
  } catch (error: any) {
    const authFailure = authErrorResponse(error);
    if (authFailure) return authFailure;
    console.error('DELETE /api/suppliers error:', error);
    return NextResponse.json(
      errorResponse(ErrorCode.DATABASE_ERROR, '删除供应商失败', error.message),
      { status: 500 }
    );
  }
}
