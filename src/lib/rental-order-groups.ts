export type RentalOrderRecord = {
  id: string;
  rentalOrderId: string | null;
  displayRentalNo?: string | null;
  rentalNo: string;
};

export function groupRentalsByOrder<T extends RentalOrderRecord>(rentals: T[]) {
  const groups = new Map<string, T[]>();
  for (const rental of rentals) {
    const orderNumber = rental.displayRentalNo || rental.rentalNo;
    const key = rental.rentalOrderId ? `id:${rental.rentalOrderId}` : `number:${orderNumber || rental.id}`;
    const group = groups.get(key);
    if (group) group.push(rental);
    else groups.set(key, [rental]);
  }
  return [...groups.entries()].map(([key, items]) => ({ key, items }));
}
