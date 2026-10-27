export interface SessionUser { id: string; username: string; realName: string | null; role: string; isSystemAccount?: boolean; warehouses: { id: string; name: string; code: string; status: string }[]; }
export function canVisit(role: string, path: string) {
  if (role === 'admin') return true;
  return ['/inventory', '/inventory/analysis', '/inventory/movements', '/transfers', '/settings/print/preview', '/settings/account'].includes(path);
}
