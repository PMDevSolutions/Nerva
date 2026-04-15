import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { todos } from '../db/schema';
import { createTodoSchema, updateTodoSchema } from '../types/todo';

interface Bindings {
  DB: D1Database;
  ENVIRONMENT: string;
}

export const todosRoutes = new Hono<{ Bindings: Bindings }>()
  // GET /todos — List all todos
  .get('/', async (c) => {
    const db = drizzle(c.env.DB);
    const allTodos = await db.select().from(todos);
    return c.json({ todos: allTodos, total: allTodos.length });
  })

  // POST /todos — Create a new todo
  .post('/', zValidator('json', createTodoSchema), async (c) => {
    const db = drizzle(c.env.DB);
    const body = c.req.valid('json');
    const result = await db.insert(todos).values({ title: body.title }).returning();
    const newTodo = result[0];
    if (!newTodo) {
      return c.json({ error: 'Failed to create todo' }, 500);
    }
    return c.json(newTodo, 201);
  })

  // GET /todos/:id — Get a specific todo
  .get('/:id', async (c) => {
    const db = drizzle(c.env.DB);
    const id = c.req.param('id');
    const result = await db.select().from(todos).where(eq(todos.id, id));
    const todo = result[0];
    if (!todo) {
      return c.json({ error: 'Todo not found' }, 404);
    }
    return c.json(todo);
  })

  // PUT /todos/:id — Update a todo
  .put('/:id', zValidator('json', updateTodoSchema), async (c) => {
    const db = drizzle(c.env.DB);
    const id = c.req.param('id');
    const body = c.req.valid('json');

    // Build the update payload, filtering out undefined values to avoid
    // exactOptionalPropertyTypes issues and only setting provided fields.
    const updates: Record<string, string | boolean> = {
      updatedAt: new Date().toISOString(),
    };
    if (body.title !== undefined) {
      updates.title = body.title;
    }
    if (body.completed !== undefined) {
      updates.completed = body.completed;
    }

    const result = await db
      .update(todos)
      .set(updates)
      .where(eq(todos.id, id))
      .returning();
    const updated = result[0];
    if (!updated) {
      return c.json({ error: 'Todo not found' }, 404);
    }
    return c.json(updated);
  })

  // DELETE /todos/:id — Delete a todo
  .delete('/:id', async (c) => {
    const db = drizzle(c.env.DB);
    const id = c.req.param('id');
    const result = await db.delete(todos).where(eq(todos.id, id)).returning();
    const deleted = result[0];
    if (!deleted) {
      return c.json({ error: 'Todo not found' }, 404);
    }
    return c.json({ message: 'Todo deleted' });
  });
