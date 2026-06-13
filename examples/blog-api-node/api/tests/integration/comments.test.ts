import { count } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { comments } from '../../src/db/schema.js';
import {
  createPost,
  createTestDb,
  jsonHeaders,
  registerUser,
  type TestApp,
  type TestDb,
} from '../helpers.js';

interface ErrorBody {
  error: { code: string; message: string };
}

let testDb: TestDb;
let app: TestApp;

beforeAll(async () => {
  testDb = await createTestDb();
  app = createApp(testDb.db);
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.reset();
});

async function addComment(token: string, postId: string, body: string): Promise<string> {
  const res = await app.request(`/posts/${postId}/comments`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ body }),
  });
  if (res.status !== 201) {
    throw new Error(`addComment expected 201, got ${String(res.status)}`);
  }
  const json = (await res.json()) as { data: { id: string } };
  return json.data.id;
}

describe('POST /posts/:postId/comments', () => {
  it('requires authentication', async () => {
    const user = await registerUser(app);
    const post = await createPost(app, user.accessToken);

    const res = await app.request(`/posts/${post.id}/comments`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ body: 'Anonymous?' }),
    });
    expect(res.status).toBe(401);
  });

  it('creates a comment on an existing post', async () => {
    const author = await registerUser(app);
    const commenter = await registerUser(app);
    const post = await createPost(app, author.accessToken);

    const res = await app.request(`/posts/${post.id}/comments`, {
      method: 'POST',
      headers: jsonHeaders(commenter.accessToken),
      body: JSON.stringify({ body: 'Nice post!' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { postId: string; authorId: string; body: string };
    };
    expect(body.data).toMatchObject({
      postId: post.id,
      authorId: commenter.id,
      body: 'Nice post!',
    });
  });

  it('returns 404 when the post does not exist', async () => {
    const user = await registerUser(app);
    const res = await app.request('/posts/4f8a2c1e-0000-4000-8000-00000000dead/comments', {
      method: 'POST',
      headers: jsonHeaders(user.accessToken),
      body: JSON.stringify({ body: 'Into the void' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /posts/:postId/comments', () => {
  it('lists comments oldest-first with public author info and meta', async () => {
    const author = await registerUser(app, { name: 'Author' });
    const commenter = await registerUser(app, { name: 'Commenter' });
    const post = await createPost(app, author.accessToken);
    await addComment(commenter.accessToken, post.id, 'First!');
    await addComment(author.accessToken, post.id, 'Thanks for reading.');

    const res = await app.request(`/posts/${post.id}/comments`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { body: string; author: Record<string, unknown> }[];
      meta: { total: number; limit: number; offset: number };
    };

    expect(body.meta).toEqual({ total: 2, limit: 20, offset: 0 });
    expect(body.data.map((c) => c.body)).toEqual(['First!', 'Thanks for reading.']);
    expect(body.data[0]?.author).toEqual({ id: commenter.id, name: 'Commenter' });
  });

  it('paginates comments', async () => {
    const user = await registerUser(app);
    const post = await createPost(app, user.accessToken);
    for (let i = 1; i <= 3; i += 1) {
      await addComment(user.accessToken, post.id, `Comment ${String(i)}`);
    }

    const res = await app.request(`/posts/${post.id}/comments?limit=2&offset=2`);
    const body = (await res.json()) as { data: { body: string }[]; meta: { total: number } };
    expect(body.meta.total).toBe(3);
    expect(body.data.map((c) => c.body)).toEqual(['Comment 3']);
  });

  it('returns 404 for comments of a missing post', async () => {
    const res = await app.request('/posts/4f8a2c1e-0000-4000-8000-00000000dead/comments');
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

describe('DELETE /comments/:id', () => {
  it('lets the comment author delete it', async () => {
    const author = await registerUser(app);
    const commenter = await registerUser(app);
    const post = await createPost(app, author.accessToken);
    const commentId = await addComment(commenter.accessToken, post.id, 'Delete me');

    const res = await app.request(`/comments/${commentId}`, {
      method: 'DELETE',
      headers: jsonHeaders(commenter.accessToken),
    });
    expect(res.status).toBe(204);

    const list = await app.request(`/posts/${post.id}/comments`);
    const body = (await list.json()) as { meta: { total: number } };
    expect(body.meta.total).toBe(0);
  });

  it("forbids deleting someone else's comment", async () => {
    const author = await registerUser(app);
    const commenter = await registerUser(app);
    const post = await createPost(app, author.accessToken);
    const commentId = await addComment(commenter.accessToken, post.id, 'Mine');

    const res = await app.request(`/comments/${commentId}`, {
      method: 'DELETE',
      headers: jsonHeaders(author.accessToken),
    });
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown comment', async () => {
    const user = await registerUser(app);
    const res = await app.request('/comments/4f8a2c1e-0000-4000-8000-00000000dead', {
      method: 'DELETE',
      headers: jsonHeaders(user.accessToken),
    });
    expect(res.status).toBe(404);
  });
});

describe('cascade behaviour', () => {
  it('deleting a post removes its comments at the database level', async () => {
    const user = await registerUser(app);
    const post = await createPost(app, user.accessToken);
    await addComment(user.accessToken, post.id, 'Will cascade');

    const del = await app.request(`/posts/${post.id}`, {
      method: 'DELETE',
      headers: jsonHeaders(user.accessToken),
    });
    expect(del.status).toBe(204);

    const [row] = await testDb.db.select({ total: count() }).from(comments);
    expect(row?.total).toBe(0);
  });
});
