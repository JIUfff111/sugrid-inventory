import { NextResponse } from 'next/server';
import { authErrorResponse, requireSystemAccount } from '@/lib/auth';
import { DATA_RESOURCES } from '@/lib/data-management';
import { errorResponse, successResponse } from '@/lib/api-helpers';

export async function GET() {
  try {
    await requireSystemAccount();
    return NextResponse.json(successResponse(Object.values(DATA_RESOURCES).map((resource) => ({
      key: resource.key,
      label: resource.label,
      fields: resource.fields,
      writable: resource.writable,
      editable: resource.writable.length > 0,
      creatable: resource.creatable !== false,
      deletable: resource.hardDeletable === true || resource.key === 'users' || (resource.deletable !== false && resource.fields.includes('deleted')),
    }))));
  } catch (error) {
    const failure = authErrorResponse(error);
    if (failure) return failure;
    return NextResponse.json(errorResponse('DATABASE_ERROR', '获取数据资源失败'), { status: 500 });
  }
}
