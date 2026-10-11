import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  RegisteredUser,
  expectErrorEnvelope,
  registerUser,
} from './utils/auth-helpers';
import { createDocument, createFolder } from './utils/document-helpers';
import { TestContext, createTestApp, resetDatabase } from './utils/test-app';

describe('Documents (e2e)', () => {
  let ctx: TestContext;
  let alice: RegisteredUser;
  let bob: RegisteredUser;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    alice = await registerUser(ctx.app, { name: 'Alice' });
    bob = await registerUser(ctx.app, { name: 'Bob' });
  });

  afterAll(async () => {
    await ctx.close();
  });

  const server = () => ctx.app.getHttpServer();
  const as = (user: RegisteredUser) => `Bearer ${user.accessToken}`;

  describe('POST /api/v1/documents', () => {
    it('creates a DRAFT document owned by the caller', async () => {
      const res = await request(server())
        .post('/api/v1/documents')
        .set('Authorization', as(alice))
        .send({ title: '  My Document  ', description: '  Optional  ' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        success: true,
        data: {
          id: expect.any(String),
          folderId: null,
          title: 'My Document',
          description: 'Optional',
          status: 'DRAFT',
          mimeType: null,
          fileSize: null,
          pageCount: null,
          originalName: null,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
        message: null,
        requestId: expect.any(String),
      });
      expect(res.body.data).not.toHaveProperty('userId');
      expect(res.body.data).not.toHaveProperty('storageKey');
      expect(res.body.data).not.toHaveProperty('deletedAt');

      const stored = await ctx.prisma.document.findUniqueOrThrow({
        where: { id: res.body.data.id },
      });
      expect(stored.userId).toBe(alice.userId);
      expect(ctx.logs.text).toContain('DOCUMENT_CREATED');
    });

    it('places the document in an owned folder', async () => {
      const folder = await createFolder(ctx.app, alice, 'Docs');
      const res = await request(server())
        .post('/api/v1/documents')
        .set('Authorization', as(alice))
        .send({ title: 'In folder', folderId: folder.id });

      expect(res.status).toBe(201);
      expect(res.body.data.folderId).toBe(folder.id);
    });

    it("rejects another user's folderId with a safe not-found", async () => {
      const bobsFolder = await createFolder(ctx.app, bob, 'Bob folder');

      const res = await request(server())
        .post('/api/v1/documents')
        .set('Authorization', as(alice))
        .send({ title: 'Sneaky', folderId: bobsFolder.id });

      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'FOLDER_NOT_FOUND');
      expect(
        await ctx.prisma.document.count({ where: { folderId: bobsFolder.id } }),
      ).toBe(0);
    });

    it.each([
      ['missing title', {}],
      ['blank title', { title: '   ' }],
      ['title too long', { title: 'x'.repeat(256) }],
      ['title with control chars', { title: 'bad\u0007title' }],
      ['description too long', { title: 'ok', description: 'd'.repeat(2001) }],
      ['non-uuid folderId', { title: 'ok', folderId: '123' }],
      ['client-supplied userId', { title: 'ok', userId: randomUUID() }],
      ['client-supplied status', { title: 'ok', status: 'READY' }],
      ['client-supplied storageKey', { title: 'ok', storageKey: 'users/x/y' }],
      ['client-supplied fileSize', { title: 'ok', fileSize: 10 }],
    ])('rejects %s with VALIDATION_ERROR', async (_label, body) => {
      const res = await request(server())
        .post('/api/v1/documents')
        .set('Authorization', as(alice))
        .send(body);

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    });

    it('rejects unauthenticated requests', async () => {
      const res = await request(server())
        .post('/api/v1/documents')
        .send({ title: 'Anonymous' });

      expect(res.status).toBe(401);
      expectErrorEnvelope(res.body, 'AUTH_UNAUTHORIZED');
    });

    it('rejects an invalid access token', async () => {
      const res = await request(server())
        .post('/api/v1/documents')
        .set('Authorization', 'Bearer not.a.jwt')
        .send({ title: 'Anonymous' });

      expect(res.status).toBe(401);
      expectErrorEnvelope(res.body, 'AUTH_INVALID_TOKEN');
    });
  });

  describe('GET /api/v1/documents', () => {
    let lister: RegisteredUser;
    let folder: { id: string };
    const titles = ['Alpha report', 'Beta invoice', 'Gamma notes', 'Delta'];

    beforeAll(async () => {
      lister = await registerUser(ctx.app);
      folder = await createFolder(ctx.app, lister, 'Listing');
      for (const [index, title] of titles.entries()) {
        await createDocument(ctx.app, lister, {
          title,
          description: index % 2 === 0 ? 'even description' : null,
          ...(index === 1 ? { folderId: folder.id } : {}),
        });
      }
      const deleted = await createDocument(ctx.app, lister, {
        title: 'Deleted one',
      });
      await request(server())
        .delete(`/api/v1/documents/${deleted.id}`)
        .set('Authorization', as(lister))
        .expect(200);
      // Another user's document must never show up.
      await createDocument(ctx.app, bob, { title: 'Alpha from Bob' });
    });

    it("returns only the caller's live documents with pagination metadata", async () => {
      const res = await request(server())
        .get('/api/v1/documents')
        .set('Authorization', as(lister));

      expect(res.status).toBe(200);
      expect(res.body.data.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 4,
        totalPages: 1,
      });
      const returned = res.body.data.items.map(
        (d: { title: string }) => d.title,
      );
      expect(returned).toEqual(expect.arrayContaining(titles));
      expect(returned).not.toContain('Deleted one');
      expect(returned).not.toContain('Alpha from Bob');
      for (const item of res.body.data.items) {
        expect(item).not.toHaveProperty('userId');
        expect(item).not.toHaveProperty('storageKey');
      }
    });

    it('paginates with a stable order', async () => {
      const page1 = await request(server())
        .get('/api/v1/documents?limit=3&sort=title&order=asc')
        .set('Authorization', as(lister));
      const page2 = await request(server())
        .get('/api/v1/documents?page=2&limit=3&sort=title&order=asc')
        .set('Authorization', as(lister));

      expect(
        page1.body.data.items.map((d: { title: string }) => d.title),
      ).toEqual(['Alpha report', 'Beta invoice', 'Delta']);
      expect(page1.body.data.pagination).toEqual({
        page: 1,
        limit: 3,
        total: 4,
        totalPages: 2,
      });
      expect(
        page2.body.data.items.map((d: { title: string }) => d.title),
      ).toEqual(['Gamma notes']);
    });

    it('filters by folder, root and status', async () => {
      const inFolder = await request(server())
        .get(`/api/v1/documents?folderId=${folder.id}`)
        .set('Authorization', as(lister));
      expect(
        inFolder.body.data.items.map((d: { title: string }) => d.title),
      ).toEqual(['Beta invoice']);

      const root = await request(server())
        .get('/api/v1/documents?folderId=null')
        .set('Authorization', as(lister));
      expect(root.body.data.pagination.total).toBe(3);

      const drafts = await request(server())
        .get('/api/v1/documents?status=DRAFT')
        .set('Authorization', as(lister));
      expect(drafts.body.data.pagination.total).toBe(4);

      const ready = await request(server())
        .get('/api/v1/documents?status=READY')
        .set('Authorization', as(lister));
      expect(ready.body.data.items).toEqual([]);
      expect(ready.body.data.pagination.totalPages).toBe(0);
    });

    it('searches title and description case-insensitively', async () => {
      const byTitle = await request(server())
        .get('/api/v1/documents?search=ALPHA')
        .set('Authorization', as(lister));
      expect(
        byTitle.body.data.items.map((d: { title: string }) => d.title),
      ).toEqual(['Alpha report']);

      const byDescription = await request(server())
        .get('/api/v1/documents?search=even%20desc&sort=title&order=asc')
        .set('Authorization', as(lister));
      expect(
        byDescription.body.data.items.map((d: { title: string }) => d.title),
      ).toEqual(['Alpha report', 'Gamma notes']);

      const injection = await request(server())
        .get(`/api/v1/documents?search=${encodeURIComponent("' OR 1=1 --")}`)
        .set('Authorization', as(lister));
      expect(injection.status).toBe(200);
      expect(injection.body.data.items).toEqual([]);
    });

    it("refuses to filter by another user's folder", async () => {
      const res = await request(server())
        .get(`/api/v1/documents?folderId=${folder.id}`)
        .set('Authorization', as(bob));

      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'FOLDER_NOT_FOUND');
    });

    it.each([
      'page=0',
      'page=abc',
      'limit=0',
      'limit=101',
      'limit=1.5',
      'sort=userId',
      'sort=storageKey',
      'order=random',
      'status=DELETED',
      'status=bogus',
      'folderId=not-a-uuid',
      `search=${'s'.repeat(201)}`,
      'unknown=1',
    ])('rejects invalid query "%s"', async (query) => {
      const res = await request(server())
        .get(`/api/v1/documents?${query}`)
        .set('Authorization', as(lister));

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    });
  });

  describe('GET /api/v1/documents/:id', () => {
    it('returns an owned document', async () => {
      const doc = await createDocument(ctx.app, alice, { title: 'Readable' });

      const res = await request(server())
        .get(`/api/v1/documents/${doc.id}`)
        .set('Authorization', as(alice));

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: doc.id, title: 'Readable' });
    });

    it("hides another user's document behind the same not-found as an unknown id", async () => {
      const doc = await createDocument(ctx.app, alice, {
        title: 'Alice secret title',
      });
      ctx.logs.clear();

      const idor = await request(server())
        .get(`/api/v1/documents/${doc.id}`)
        .set('Authorization', as(bob));
      const unknown = await request(server())
        .get(`/api/v1/documents/${randomUUID()}`)
        .set('Authorization', as(bob));

      expect(idor.status).toBe(404);
      expectErrorEnvelope(idor.body, 'DOCUMENT_NOT_FOUND');
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe(idor.body.code);
      expect(unknown.body.message).toBe(idor.body.message);
      expect(JSON.stringify(idor.body)).not.toContain('secret');
      expect(ctx.logs.text).toContain('DOCUMENT_ACCESS_DENIED');
    });

    it('rejects a malformed id', async () => {
      const res = await request(server())
        .get('/api/v1/documents/42')
        .set('Authorization', as(alice));

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    });
  });

  describe('PATCH /api/v1/documents/:id', () => {
    it('updates title, description and folder', async () => {
      const doc = await createDocument(ctx.app, alice, { title: 'Before' });
      const folder = await createFolder(ctx.app, alice, 'Target');

      const res = await request(server())
        .patch(`/api/v1/documents/${doc.id}`)
        .set('Authorization', as(alice))
        .send({
          title: 'After',
          description: 'Now described',
          folderId: folder.id,
        });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: doc.id,
        title: 'After',
        description: 'Now described',
        folderId: folder.id,
        status: 'DRAFT',
      });

      const toRoot = await request(server())
        .patch(`/api/v1/documents/${doc.id}`)
        .set('Authorization', as(alice))
        .send({ folderId: null, description: null });
      expect(toRoot.status).toBe(200);
      expect(toRoot.body.data.folderId).toBeNull();
      expect(toRoot.body.data.description).toBeNull();
      expect(ctx.logs.text).toContain('DOCUMENT_UPDATED');
    });

    it("cannot move a document into another user's folder", async () => {
      const doc = await createDocument(ctx.app, alice, { title: 'Stay' });
      const bobsFolder = await createFolder(ctx.app, bob, 'Bob target');

      const res = await request(server())
        .patch(`/api/v1/documents/${doc.id}`)
        .set('Authorization', as(alice))
        .send({ folderId: bobsFolder.id });

      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'FOLDER_NOT_FOUND');
      const stored = await ctx.prisma.document.findUniqueOrThrow({
        where: { id: doc.id },
      });
      expect(stored.folderId).toBeNull();
    });

    it("cannot update another user's document", async () => {
      const doc = await createDocument(ctx.app, alice, {
        title: 'Untouchable',
      });

      const res = await request(server())
        .patch(`/api/v1/documents/${doc.id}`)
        .set('Authorization', as(bob))
        .send({ title: 'Hacked' });

      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'DOCUMENT_NOT_FOUND');
      const stored = await ctx.prisma.document.findUniqueOrThrow({
        where: { id: doc.id },
      });
      expect(stored.title).toBe('Untouchable');
    });

    it.each([
      ['userId', randomUUID()],
      ['status', 'READY'],
      ['storageKey', 'users/another-user/private.pdf'],
      ['fileSize', 123],
      ['mimeType', 'application/pdf'],
      ['originalName', 'x.pdf'],
      ['pageCount', 3],
      ['createdAt', '2000-01-01T00:00:00.000Z'],
      ['deletedAt', null],
      ['id', randomUUID()],
    ])('rejects the server-controlled field %s', async (field, value) => {
      const doc = await createDocument(ctx.app, alice, { title: 'Strict' });

      const res = await request(server())
        .patch(`/api/v1/documents/${doc.id}`)
        .set('Authorization', as(alice))
        .send({ title: 'Still fine', [field]: value });

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
      expect(res.body.message).toContain(`property ${field} should not exist`);

      const stored = await ctx.prisma.document.findUniqueOrThrow({
        where: { id: doc.id },
      });
      expect(stored.title).toBe('Strict');
      expect(stored.status).toBe('DRAFT');
      expect(stored.storageKey).toBeNull();
    });

    it('rejects an empty title', async () => {
      const doc = await createDocument(ctx.app, alice, { title: 'Keep' });

      const res = await request(server())
        .patch(`/api/v1/documents/${doc.id}`)
        .set('Authorization', as(alice))
        .send({ title: '  ' });

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    });
  });

  describe('DELETE /api/v1/documents/:id', () => {
    it('soft-deletes: row kept, status DELETED, invisible afterwards', async () => {
      const doc = await createDocument(ctx.app, alice, { title: 'Doomed' });

      const res = await request(server())
        .delete(`/api/v1/documents/${doc.id}`)
        .set('Authorization', as(alice));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: {
          id: doc.id,
          status: 'DELETED',
          deletedAt: expect.any(String),
        },
        message: 'Document deleted',
        requestId: expect.any(String),
      });

      const stored = await ctx.prisma.document.findUniqueOrThrow({
        where: { id: doc.id },
      });
      expect(stored.status).toBe('DELETED');
      expect(stored.deletedAt).not.toBeNull();
      expect(ctx.logs.text).toContain('DOCUMENT_DELETED');

      const attempts: Array<() => request.Test> = [
        () => request(server()).get(`/api/v1/documents/${doc.id}`),
        () =>
          request(server())
            .patch(`/api/v1/documents/${doc.id}`)
            .send({ title: 'Zombie' }),
        () => request(server()).delete(`/api/v1/documents/${doc.id}`),
        () => request(server()).get(`/api/v1/documents/${doc.id}/download-url`),
        () =>
          request(server())
            .post(`/api/v1/documents/${doc.id}/upload-url`)
            .send({
              fileName: 'a.pdf',
              contentType: 'application/pdf',
              fileSize: 10,
            }),
        () =>
          request(server())
            .post(`/api/v1/documents/${doc.id}/upload-complete`)
            .send({}),
      ];
      for (const attempt of attempts) {
        const after = await attempt().set('Authorization', as(alice));
        expect(after.status).toBe(404);
        expectErrorEnvelope(after.body, 'DOCUMENT_NOT_FOUND');
      }

      const list = await request(server())
        .get('/api/v1/documents?search=Doomed')
        .set('Authorization', as(alice));
      expect(list.body.data.items).toEqual([]);
    });

    it("cannot delete another user's document", async () => {
      const doc = await createDocument(ctx.app, alice, { title: 'Alive' });

      const res = await request(server())
        .delete(`/api/v1/documents/${doc.id}`)
        .set('Authorization', as(bob));

      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'DOCUMENT_NOT_FOUND');
      const stored = await ctx.prisma.document.findUniqueOrThrow({
        where: { id: doc.id },
      });
      expect(stored.deletedAt).toBeNull();
      expect(stored.status).toBe('DRAFT');
    });

    it('lets exactly one of two concurrent deletes succeed', async () => {
      const doc = await createDocument(ctx.app, alice, { title: 'Race' });

      const results = await Promise.all([
        request(server())
          .delete(`/api/v1/documents/${doc.id}`)
          .set('Authorization', as(alice)),
        request(server())
          .delete(`/api/v1/documents/${doc.id}`)
          .set('Authorization', as(alice)),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    });

    it('a concurrent update cannot resurrect a deleted document', async () => {
      const doc = await createDocument(ctx.app, alice, { title: 'Final' });
      await request(server())
        .delete(`/api/v1/documents/${doc.id}`)
        .set('Authorization', as(alice))
        .expect(200);

      const res = await request(server())
        .patch(`/api/v1/documents/${doc.id}`)
        .set('Authorization', as(alice))
        .send({ title: 'Back from the dead' });

      expect(res.status).toBe(404);
      const stored = await ctx.prisma.document.findUniqueOrThrow({
        where: { id: doc.id },
      });
      expect(stored.title).toBe('Final');
      expect(stored.status).toBe('DELETED');
    });
  });

  it('refuses a suspended user even with a still-valid access token', async () => {
    const suspended = await registerUser(ctx.app);
    const doc = await createDocument(ctx.app, suspended, { title: 'Pre' });
    await ctx.prisma.user.update({
      where: { id: suspended.userId },
      data: { status: 'SUSPENDED' },
    });

    const res = await request(server())
      .get(`/api/v1/documents/${doc.id}`)
      .set('Authorization', as(suspended));

    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, 'AUTH_ACCOUNT_SUSPENDED');
  });
});
