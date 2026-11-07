export interface SessionUser { id: string; username: string; realName: string | null; role: string; isSystemAccount?: boolean; canViewInventory?: boolean; canEditInventory?: boolean; warehouses: { id: string; name: string; code: string; status: string }[]; }
export function canVisit(role: string, path: string, canViewInventory = true) {
  if (role === 'viewer') return path === '/settings/account' || (canViewInventory && path === '/inventory');
  if (!canViewInventory && ['/inventory', '/inventory/analysis', '/inventory/movements', '/transfers'].includes(path)) return false;
  if (role === 'admin') return true;
  if (role !== 'warehouse_manager') return path === '/settings/account';
  return ['/inventory', '/inventory/analysis', '/inventory/movements', '/transfers', '/settings/print/preview', '/settings/account'].includes(path);
}
