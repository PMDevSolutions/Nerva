import { z } from 'zod';

// Offset-based pagination: ?limit=20&offset=40. The schema coerces query
// strings to numbers and clamps the page size.
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type Pagination = z.infer<typeof paginationQuerySchema>;

export interface PageMeta {
  total: number;
  limit: number;
  offset: number;
}

export function pageMeta(total: number, { limit, offset }: Pagination): PageMeta {
  return { total, limit, offset };
}
