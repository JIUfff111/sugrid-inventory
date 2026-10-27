import { requireRole, authErrorResponse } from '@/lib/auth';
/**
 * SKU 库管理 API
 * GET    /api/skus       获取 SKU 列表
 * POST   /api/skus       新增 SKU
 * PUT    /api/skus       更新 SKU
 * DELETE /api/skus       删除 SKU（逻辑删除）
 */

import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { canonicalSKUBrand } from '@/lib/sku-brand';
import {
  successResponse,
  errorResponse,
  ErrorCode,
  generateId,
  parsePaginationParams,
  createPaginatedResponse,
  notDeletedCondition
} from '@/lib/api-helpers';

export interface SKU {
  id: string;
  productType: string;
  brand: string;
  model: string;
  year: number | null;
  cpuOptions: string; // JSON 字符串数组
  ramOptions: string;
  gpuOptions: string;
  storageOptions: string;
  screenOptions: string;
  priceMin?: number;
  priceMax?: number;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

function normalizeYear(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const year = Number(value);
  return Number.isInteger(year) && year >= 1900 && year <= 2100 ? year : null;
}

/**
 * GET /api/skus - 获取 SKU 列表
 */
export async function GET(request: NextRequest) {
  try {
    await requireRole('admin');
    const { searchParams } = new URL(request.url);
    const { page, pageSize } = parsePaginationParams(searchParams);
    const productType = searchParams.get('productType') || '';
    const brand = canonicalSKUBrand(searchParams.get('brand') || '');
    const search = searchParams.get('search') || '';
    
    // 构建查询条件
    let whereConditions = [notDeletedCondition];
    let params: any[] = [];
    
    if (productType) {
      whereConditions.push('productType = ?');
      params.push(productType);
    }
    
    if (brand) {
      whereConditions.push('brand = ?');
      params.push(brand);
    }
    
    if (search) {
      whereConditions.push("(brand LIKE ? OR model LIKE ? OR (brand || ' ' || model) LIKE ? OR CAST(year AS TEXT) LIKE ?)");
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern, searchPattern, searchPattern);
    }
    
    const whereClause = whereConditions.join(' AND ');
    
    // 查询总数
    const countResult = db.prepare(`
      SELECT COUNT(*) as total FROM skus WHERE ${whereClause}
    `).get(...params) as { total: number };
    
    // 查询列表
    const offset = (page - 1) * pageSize;
    const skus = db.prepare(`
      SELECT * FROM skus 
      WHERE ${whereClause}
      ORDER BY productType, brand, year DESC, model
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as SKU[];
    
    // 解析 JSON 字段
    const parsedSkus = skus.map(sku => ({
      ...sku,
      cpuOptions: JSON.parse(sku.cpuOptions || '[]'),
      ramOptions: JSON.parse(sku.ramOptions || '[]'),
      gpuOptions: JSON.parse(sku.gpuOptions || '[]'),
      storageOptions: JSON.parse(sku.storageOptions || '[]'),
      screenOptions: JSON.parse(sku.screenOptions || '[]'),
    }));
    
    const paginatedData = createPaginatedResponse(
      parsedSkus,
      countResult.total,
      page,
      pageSize
    );
    
    return NextResponse.json(successResponse(paginatedData));
    
  } catch (error: any) {
    const authFailure = authErrorResponse(error);
    if (authFailure) return authFailure;
    console.error('GET /api/skus error:', error);
    return NextResponse.json(
      errorResponse(ErrorCode.DATABASE_ERROR, '获取 SKU 列表失败', error.message),
      { status: 500 }
    );
  }
}

/**
 * POST /api/skus - 新增 SKU
 */
export async function POST(request: NextRequest) {
  try {
    await requireRole('admin');
    const body = await request.json();
    const {
      productType,
      brand,
      model,
      year,
      cpuOptions,
      ramOptions,
      gpuOptions,
      storageOptions,
      screenOptions,
      priceMin,
      priceMax
    } = body;
    
    // 验证必填字段
    if (!productType?.trim() || !brand?.trim() || !model?.trim()) {
      return NextResponse.json(
        errorResponse(ErrorCode.VALIDATION_ERROR, '产品类型、品牌和型号不能为空'),
        { status: 400 }
      );
    }
    
    const canonicalBrand = canonicalSKUBrand(brand);
    // 检查是否已存在相同的 SKU
    const normalizedYear = normalizeYear(year);
    const yearCondition = normalizedYear === null ? 'year IS NULL' : 'year = ?';
    const existingSku = db.prepare(`
      SELECT id FROM skus 
      WHERE productType = ? AND brand = ? AND model = ? AND ${yearCondition} AND ${notDeletedCondition}
    `).get(...[productType.trim(), canonicalBrand, model.trim(), ...(normalizedYear === null ? [] : [normalizedYear])]) as { id: string } | undefined;
    
    if (existingSku) {
      return NextResponse.json(
        errorResponse(ErrorCode.DUPLICATE_ENTRY, '该 SKU 已存在'),
        { status: 400 }
      );
    }
    
    // 插入新 SKU
    const skuId = generateId('sku');
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const user = db.prepare('SELECT id FROM users ORDER BY createdAt ASC LIMIT 1').get() as { id: string } | undefined;
    if (!user?.id) {
      return NextResponse.json(
        errorResponse(ErrorCode.DATABASE_ERROR, '系统用户不存在，无法创建 SKU'),
        { status: 500 }
      );
    }
    const createdBy = user.id;
    
    db.prepare(`
      INSERT INTO skus (
        id, productType, brand, model,
        year,
        cpuOptions, ramOptions, gpuOptions, storageOptions, screenOptions,
        priceMin, priceMax, deleted, createdBy, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(
      skuId,
      productType.trim(),
      canonicalBrand,
      model.trim(),
      normalizedYear,
      JSON.stringify(cpuOptions || []),
      JSON.stringify(ramOptions || []),
      JSON.stringify(gpuOptions || []),
      JSON.stringify(storageOptions || []),
      JSON.stringify(screenOptions || []),
      priceMin || null,
      priceMax || null,
      createdBy,
      now,
      now
    );
    
    // 查询新插入的记录
    const newSku = db.prepare('SELECT * FROM skus WHERE id = ?').get(skuId) as SKU;
    
    return NextResponse.json(successResponse({
      ...newSku,
      cpuOptions: JSON.parse(newSku.cpuOptions),
      ramOptions: JSON.parse(newSku.ramOptions),
      gpuOptions: JSON.parse(newSku.gpuOptions),
      storageOptions: JSON.parse(newSku.storageOptions),
      screenOptions: JSON.parse(newSku.screenOptions),
    }), { status: 201 });
    
  } catch (error: any) {
    const authFailure = authErrorResponse(error);
    if (authFailure) return authFailure;
    console.error('POST /api/skus error:', error);
    return NextResponse.json(
      errorResponse(ErrorCode.DATABASE_ERROR, '新增 SKU 失败', error.message),
      { status: 500 }
    );
  }
}

/**
 * PUT /api/skus - 更新 SKU
 */
export async function PUT(request: NextRequest) {
  try {
    await requireRole('admin');
    const body = await request.json();
    const {
      id,
      productType,
      brand,
      model,
      year,
      cpuOptions,
      ramOptions,
      gpuOptions,
      storageOptions,
      screenOptions,
      priceMin,
      priceMax
    } = body;
    
    if (!id) {
      return NextResponse.json(
        errorResponse(ErrorCode.VALIDATION_ERROR, 'SKU ID 不能为空'),
        { status: 400 }
      );
    }
    
    // 检查 SKU 是否存在
    const existingSku = db.prepare(`
      SELECT id FROM skus WHERE id = ? AND ${notDeletedCondition}
    `).get(id) as { id: string } | undefined;
    
    if (!existingSku) {
      return NextResponse.json(
        errorResponse(ErrorCode.NOT_FOUND, 'SKU 不存在'),
        { status: 404 }
      );
    }

    if (typeof productType !== 'string' || typeof brand !== 'string' || typeof model !== 'string' ||
        !productType.trim() || !brand.trim() || !model.trim()) {
      return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '产品类型、品牌和型号不能为空'), { status: 400 });
    }
    
    const canonicalBrand = canonicalSKUBrand(brand);
    // 更新 SKU
    const normalizedYear = normalizeYear(year);
    const yearCondition = normalizedYear === null ? 'year IS NULL' : 'year = ?';
    const duplicate = db.prepare(`SELECT id FROM skus
      WHERE id <> ? AND productType = ? AND brand = ? AND model = ? AND ${yearCondition} AND ${notDeletedCondition}`)
      .get(id, productType.trim(), canonicalBrand, model.trim(), ...(normalizedYear === null ? [] : [normalizedYear]));
    if (duplicate) {
      return NextResponse.json(errorResponse(ErrorCode.DUPLICATE_ENTRY, '该 SKU 已存在'), { status: 400 });
    }
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    
    db.prepare(`
      UPDATE skus 
      SET productType = ?, brand = ?, model = ?,
          year = ?, cpuOptions = ?, ramOptions = ?, gpuOptions = ?,
          storageOptions = ?, screenOptions = ?,
          priceMin = ?, priceMax = ?, updatedAt = ?
      WHERE id = ?
    `).run(
      productType.trim(),
      canonicalBrand,
      model.trim(),
      normalizedYear,
      JSON.stringify(cpuOptions || []),
      JSON.stringify(ramOptions || []),
      JSON.stringify(gpuOptions || []),
      JSON.stringify(storageOptions || []),
      JSON.stringify(screenOptions || []),
      priceMin || null,
      priceMax || null,
      now,
      id
    );
    
    // 查询更新后的记录
    const updatedSku = db.prepare('SELECT * FROM skus WHERE id = ?').get(id) as SKU;
    
    return NextResponse.json(successResponse({
      ...updatedSku,
      cpuOptions: JSON.parse(updatedSku.cpuOptions),
      ramOptions: JSON.parse(updatedSku.ramOptions),
      gpuOptions: JSON.parse(updatedSku.gpuOptions),
      storageOptions: JSON.parse(updatedSku.storageOptions),
      screenOptions: JSON.parse(updatedSku.screenOptions),
    }));
    
  } catch (error: any) {
    const authFailure = authErrorResponse(error);
    if (authFailure) return authFailure;
    console.error('PUT /api/skus error:', error);
    return NextResponse.json(
      errorResponse(ErrorCode.DATABASE_ERROR, '更新 SKU 失败', error.message),
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/skus - 删除 SKU（逻辑删除）
 */
export async function DELETE(request: NextRequest) {
  try {
    await requireRole('admin');
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    
    if (!id) {
      return NextResponse.json(
        errorResponse(ErrorCode.VALIDATION_ERROR, 'SKU ID 不能为空'),
        { status: 400 }
      );
    }
    
    // 检查 SKU 是否存在
    const existingSku = db.prepare(`
      SELECT id FROM skus WHERE id = ? AND ${notDeletedCondition}
    `).get(id) as { id: string } | undefined;
    
    if (!existingSku) {
      return NextResponse.json(
        errorResponse(ErrorCode.NOT_FOUND, 'SKU 不存在'),
        { status: 404 }
      );
    }
    
    // 逻辑删除
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    db.prepare('UPDATE skus SET deleted = 1, updatedAt = ? WHERE id = ?').run(now, id);
    
    return NextResponse.json(successResponse({ id }));
    
  } catch (error: any) {
    const authFailure = authErrorResponse(error);
    if (authFailure) return authFailure;
    console.error('DELETE /api/skus error:', error);
    return NextResponse.json(
      errorResponse(ErrorCode.DATABASE_ERROR, '删除 SKU 失败', error.message),
      { status: 500 }
    );
  }
}
