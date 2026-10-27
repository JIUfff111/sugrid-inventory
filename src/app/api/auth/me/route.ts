import { NextResponse } from 'next/server';
import { errorResponse, ErrorCode, successResponse } from '@/lib/api-helpers';
import { getCurrentUser, publicUser } from '@/lib/auth';

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json(errorResponse(ErrorCode.UNAUTHORIZED, '登录已失效，请重新登录'), { status: 401, headers: { 'Cache-Control': 'no-store' } });
    return NextResponse.json(successResponse({
      user: publicUser(user),
      testMode: process.env.INVENTORY_TEST_MODE === '1',
    }), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    // A temporary database/server failure must never look like an expired
    // session: clients preserve their workspaces and offer a retry for 5xx.
    console.error('GET /api/auth/me failed:', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, '暂时无法验证登录，请重试'), { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}

