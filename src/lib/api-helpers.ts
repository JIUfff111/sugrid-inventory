/**
 * API 统一响应格式
 */

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  timestamp: string;
}

/**
 * 成功响应
 */
export function successResponse<T>(data: T): ApiResponse<T> {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString()
  };
}

/**
 * 错误响应
 */
export function errorResponse(code: string, message: string, details?: any): ApiResponse {
  return {
    success: false,
    error: {
      code,
      message,
      details
    },
    timestamp: new Date().toISOString()
  };
}

/**
 * 常见错误码
 */
export const ErrorCode = {
  // 通用错误
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  
  // 数据库错误
  DATABASE_ERROR: 'DATABASE_ERROR',
  DUPLICATE_ENTRY: 'DUPLICATE_ENTRY',
  
  // 业务逻辑错误
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  SN_ALREADY_EXISTS: 'SN_ALREADY_EXISTS',
  PURCHASE_ORDER_NOT_FOUND: 'PURCHASE_ORDER_NOT_FOUND',
  INVENTORY_NOT_FOUND: 'INVENTORY_NOT_FOUND',
  SUPPLIER_NOT_FOUND: 'SUPPLIER_NOT_FOUND',
  CANNOT_DELETE_IN_USE: 'CANNOT_DELETE_IN_USE',
};

/**
 * 分页参数
 */
export interface PaginationParams {
  page: number;
  pageSize: number;
}

/**
 * 分页响应
 */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * 创建分页响应
 */
export function createPaginatedResponse<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number
): PaginatedResponse<T> {
  return {
    items,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize)
  };
}

/**
 * 解析分页参数
 */
export function parsePaginationParams(searchParams: URLSearchParams): PaginationParams {
  const parsedPage = Number.parseInt(searchParams.get('page') || '1', 10);
  const parsedPageSize = Number.parseInt(searchParams.get('pageSize') || '20', 10);
  const page = Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1;
  const pageSize = Number.isFinite(parsedPageSize)
    ? Math.min(100, Math.max(1, parsedPageSize))
    : 20;
  
  return { page, pageSize };
}

/**
 * ID 生成器
 */
export function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * 生成采购单号（CG + 年月日 + 3位流水号）
 */
export function generatePurchaseNo(db: any): string {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
  
  // 查询今天的最大流水号
  const result = db.prepare(`
    SELECT purchaseNo FROM purchase_orders 
    WHERE purchaseNo LIKE ? 
    ORDER BY purchaseNo DESC 
    LIMIT 1
  `).get(`CG${dateStr}%`) as { purchaseNo: string } | undefined;
  
  let sequence = 1;
  if (result) {
    const lastSequence = parseInt(result.purchaseNo.slice(-3));
    sequence = lastSequence + 1;
  }
  
  return `CG${dateStr}${sequence.toString().padStart(3, '0')}`;
}

/**
 * 格式化日期时间（用于数据库）
 */
export function formatDateTime(date: Date = new Date()): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * 逻辑删除过滤条件
 */
export const notDeletedCondition = 'deleted = 0';
