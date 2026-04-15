import { z } from 'zod';

export const createTodoSchema = z.object({
  title: z.string().min(1, 'Title is required').max(255, 'Title must be 255 characters or less'),
});

export const updateTodoSchema = z.object({
  title: z.string().min(1, 'Title is required').max(255, 'Title must be 255 characters or less').optional(),
  completed: z.boolean().optional(),
});

export type CreateTodo = z.infer<typeof createTodoSchema>;
export type UpdateTodo = z.infer<typeof updateTodoSchema>;
