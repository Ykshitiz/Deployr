const MAX_LENGTH = 5;
const SUBSET = "123456789qwertyuiopalkdjfjhgzmxnvbcs";

export function generate(): string {
  let ans = "";
  for (let i = 0; i < MAX_LENGTH; i++) {
    ans += SUBSET[Math.floor(Math.random() * SUBSET.length)];
  }
  return ans;
}

/** Runs `fn` over `items` with at most `limit` promises in flight. */
export async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0;

  const workers = Array.from(
    { length: Math.min(Math.max(limit, 1), items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        await fn(items[index], index);
      }
    }
  );

  await Promise.all(workers);
}
