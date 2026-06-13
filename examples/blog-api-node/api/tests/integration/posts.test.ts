import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
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

describe('POST /posts', () => {
  it('requires authentication', async () => {
    const res = await app.request('/posts', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ title: 'Nope', content: 'No token.' }),
    });
    expect(res.status).toBe(401);
  });

  it('creates a post owned by the caller', async () => {
    const user = await registerUser(app);
    const res = await app.request('/posts', {
      method: 'POST',
      headers: jsonHeaders(user.accessToken),
      body: JSON.stringify({ title: 'First post', content: 'Hello world.' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; authorId: string; title: string } };
    expect(body.data.authorId).toBe(user.id);
    expect(body.data.title).toBe('First post');
  });

  it('rejects an empty title with 400 VALIDATION_ERROR', async () => {
    const user = await registerUser(app);
    const res = await app.request('/posts', {
      method: 'POST',
      headers: jsonHeaders(user.accessToken),
      body: JSON.stringify({ title: '', content: 'Body.' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /posts', () => {
  it('lists posts newest-first with the author embedded (public fields only)', async () => {
    const user = await registerUser(app, { name: 'Author Jane' });
    await createPost(app, user.accessToken, { title: 'Older' });
    await createPost(app, user.accessToken, { title: 'Newer' });

    const res = await app.request('/posts');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { title: string; author: Record<string, unknown> }[];
      meta: { total: number };
    };

    expect(body.meta.total).toBe(2);
    expect(body.data.map((p) => p.title)).toEqual(['Newer', 'Older']);
    expect(body.data[0]?.author).toEqual({ id: user.id, name: 'Author Jane' });
  });

  it('paginates with limit/offset and reports meta', async () => {
    const user = await registerUser(app);
    for (let i = 1; i <= 5; i += 1) {
      await createPost(app, user.accessToken, { title: `Post ${String(i)}` });
    }

    const firstPage = await app.request('/posts?limit=2&offset=0');
    const firstBody = (await firstPage.json()) as {
      data: { title: string }[];
      meta: { total: number; limit: number; offset: number };
    };
    expect(firstBody.meta).toEqual({ total: 5, limit: 2, offset: 0 });
    expect(firstBody.data.map((p) => p.title)).toEqual(['Post 5', 'Post 4']);

    const lastPage = await app.request('/posts?limit=2&offset=4');
    const lastBody = (await lastPage.json()) as { data: { title: string }[] };
    expect(lastBody.data.map((p) => p.title)).toEqual(['Post 1']);
  });

  it('rejects an out-of-range limit', async () => {
    const res = await app.request('/posts?limit=500');
    expect(res.status).toBe(400);
  });
});

describe('GET /posts/:id', () => {
  it('returns the post with its author', async () => {
    const user = await registerUser(app);
    const post = await createPost(app, user.accessToken);

    const res = await app.request(`/posts/${post.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; author: { id: string } } };
    expect(body.data.id).toBe(post.id);
    expect(body.data.author.id).toBe(user.id);
  });

  it('returns 404 for a missing post', async () => {
    const res = await app.request('/posts/4f8a2c1e-0000-4000-8000-00000000dead');
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 for a malformed id', async () => {
    const res = await app.request('/posts/not-a-uuid');
    expect(res.status).toBe(400);
  });
});

describe('PATCH /posts/:id', () => {
  it('lets the author update title and content', async () => {
    const user = await registerUser(app);
    const post = await createPost(app, user.accessToken, { title: 'Draft' });

    const res = await app.request(`/posts/${post.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(user.accessToken),
      body: JSON.stringify({ title: 'Published' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { title: string; content: string } };
    expect(body.data.title).toBe('Published');
    expect(body.data.content).toBe(post.content);
  });

  it('updates only the content when the title is omitted', async () => {
    const user = await registerUser(app);
    const post = await createPost(app, user.accessToken, { title: 'Keep me' });

    const res = await app.request(`/posts/${post.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(user.accessToken),
      body: JSON.stringify({ content: 'Rewritten body.' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { title: string; content: string } };
    expect(body.data.title).toBe('Keep me');
    expect(body.data.content).toBe('Rewritten body.');
  });

  it('forbids non-authors with 403 FORBIDDEN', async () => {
    const author = await registerUser(app);
    const intruder = await registerUser(app);
    const post = await createPost(app, author.accessToken);

    const res = await app.request(`/posts/${post.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(intruder.accessToken),
      body: JSON.stringify({ title: 'Hijacked' }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('rejects an empty patch body', async () => {
    const user = await registerUser(app);
    const post = await createPost(app, user.accessToken);

    const res = await app.request(`/posts/${post.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(user.accessToken),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});

describe('DELETE /posts/:id', () => {
  it('lets the author delete; the post is gone afterwards', async () => {
    const user = await registerUser(app);
    const post = await createPost(app, user.accessToken);

    const del = await app.request(`/posts/${post.id}`, {
      method: 'DELETE',
      headers: jsonHeaders(user.accessToken),
    });
    expect(del.status).toBe(204);

    const get = await app.request(`/posts/${post.id}`);
    expect(get.status).toBe(404);
  });

  it('forbids non-authors', async () => {
    const author = await registerUser(app);
    const intruder = await registerUser(app);
    const post = await createPost(app, author.accessToken);

    const res = await app.request(`/posts/${post.id}`, {
      method: 'DELETE',
      headers: jsonHeaders(intruder.accessToken),
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /users/:id and /users/:id/posts', () => {
  it('exposes a public profile without the email', async () => {
    const user = await registerUser(app, { name: 'Public Pat' });
    const res = await app.request(`/users/${user.id}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data['name']).toBe('Public Pat');
    expect(body.data).not.toHaveProperty('email');
    expect(body.data).not.toHaveProperty('passwordHash');
  });

  it('lists a user posts with pagination meta', async () => {
    const author = await registerUser(app);
    const other = await registerUser(app);
    await createPost(app, author.accessToken, { title: 'Mine' });
    await createPost(app, other.accessToken, { title: 'Not mine' });

    const res = await app.request(`/users/${author.id}/posts`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { title: string }[]; meta: { total: number } };
    expect(body.meta.total).toBe(1);
    expect(body.data[0]?.title).toBe('Mine');
  });

  it('returns 404 for an unknown user', async () => {
    const res = await app.request('/users/4f8a2c1e-0000-4000-8000-00000000dead/posts');
    expect(res.status).toBe(404);
  });
});
