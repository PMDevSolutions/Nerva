import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import app from '../../src/index';
import { createTestDatabase, seedTodo } from '../helpers';

interface TodoItem {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
}

let db: D1Database;
let cleanup: () => Promise<void>;

const env = (): { DB: D1Database; ENVIRONMENT: string } => ({
  DB: db,
  ENVIRONMENT: 'test',
});

beforeAll(async () => {
  const testDb = await createTestDatabase();
  db = testDb.db;
  cleanup = testDb.cleanup;
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await db.exec('DELETE FROM todos');
});

// ---------- GET /todos ----------

describe('GET /todos', () => {
  it('returns empty array when no todos exist', async () => {
    const res = await app.request('/todos', {}, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { todos: TodoItem[]; total: number };
    expect(body.todos).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('returns all todos', async () => {
    await seedTodo(db, 'id-1', 'First todo');
    await seedTodo(db, 'id-2', 'Second todo');

    const res = await app.request('/todos', {}, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { todos: TodoItem[]; total: number };
    expect(body.total).toBe(2);
    expect(body.todos).toHaveLength(2);
  });
});

// ---------- POST /todos ----------

describe('POST /todos', () => {
  it('creates a new todo', async () => {
    const res = await app.request(
      '/todos',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Buy groceries' }),
      },
      env(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as TodoItem;
    expect(body.title).toBe('Buy groceries');
    expect(body.completed).toBe(false);
    expect(body.id).toBeDefined();
    expect(body.createdAt).toBeDefined();
    expect(body.updatedAt).toBeDefined();
  });

  it('returns 400 when title is missing', async () => {
    const res = await app.request(
      '/todos',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      env(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when title is empty string', async () => {
    const res = await app.request(
      '/todos',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '' }),
      },
      env(),
    );
    expect(res.status).toBe(400);
  });
});

// ---------- GET /todos/:id ----------

describe('GET /todos/:id', () => {
  it('returns a specific todo', async () => {
    await seedTodo(db, 'find-me', 'Found todo');

    const res = await app.request('/todos/find-me', {}, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as TodoItem;
    expect(body.id).toBe('find-me');
    expect(body.title).toBe('Found todo');
    expect(body.completed).toBe(false);
  });

  it('returns 404 for non-existent todo', async () => {
    const res = await app.request('/todos/does-not-exist', {}, env());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Todo not found');
  });
});

// ---------- PUT /todos/:id ----------

describe('PUT /todos/:id', () => {
  it('updates a todo title', async () => {
    await seedTodo(db, 'update-title', 'Old title');

    const res = await app.request(
      '/todos/update-title',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New title' }),
      },
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TodoItem;
    expect(body.title).toBe('New title');
    expect(body.id).toBe('update-title');
  });

  it('updates a todo completed status', async () => {
    await seedTodo(db, 'complete-me', 'Some task');

    const res = await app.request(
      '/todos/complete-me',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: true }),
      },
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TodoItem;
    expect(body.completed).toBe(true);
  });

  it('returns 404 for non-existent todo', async () => {
    const res = await app.request(
      '/todos/does-not-exist',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated' }),
      },
      env(),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Todo not found');
  });
});

// ---------- DELETE /todos/:id ----------

describe('DELETE /todos/:id', () => {
  it('deletes a todo', async () => {
    await seedTodo(db, 'delete-me', 'Goodbye');

    const res = await app.request('/todos/delete-me', { method: 'DELETE' }, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('Todo deleted');

    // Verify it's actually gone
    const verifyRes = await app.request('/todos/delete-me', {}, env());
    expect(verifyRes.status).toBe(404);
  });

  it('returns 404 for non-existent todo', async () => {
    const res = await app.request('/todos/does-not-exist', { method: 'DELETE' }, env());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Todo not found');
  });
});
