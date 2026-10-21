import { NextRequest, NextResponse } from 'next/server';
import { destroySession } from '@/lib/auth';
import { successResponse } from '@/lib/api-helpers';

export async function POST(request: NextRequest) {
  await destroySession(undefined, request);
  return NextResponse.json(successResponse({ loggedOut: true }));
}

