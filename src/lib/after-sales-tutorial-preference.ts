const tutorialVersion = 2;

export function afterSalesTutorialKey(userId: string, version = tutorialVersion) {
  return `sugrid:after-sales:tutorial:v${version}:${userId}`;
}

export function canAutoShowAfterSalesTutorial({ active, userId, linkedRecord, busy }: {
  active: boolean;
  userId: string | undefined;
  linkedRecord: boolean;
  busy: boolean;
}) {
  return active && Boolean(userId) && !linkedRecord && !busy;
}
