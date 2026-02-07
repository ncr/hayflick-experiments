export type InventoryItem = {
  id: string;
  count: number;
};

export function mergeInventory(items: InventoryItem[]): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    acc[item.id] = (acc[item.id] ?? 0) + item.count;
    return acc;
  }, {});
}

export * from "./ecs";
