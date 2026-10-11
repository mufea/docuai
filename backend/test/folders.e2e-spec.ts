import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  RegisteredUser,
  expectErrorEnvelope,
  registerUser,
} from './utils/auth-helpers';
import { TestContext, createTestApp, resetDatabase } from './utils/test-app';

describe('Folders (e2e)', () => {
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

  async function createFolder(
    user: RegisteredUser,
    name: string,
    parentId: string | null = null,
  ): Promise<{ id: string; name: string; parentId: string | null }> {
    const res = await request(server())
      .post('/api/v1/folders')
      .set('Authorization', as(user))
      .send(parentId ? { name, parentId } : { name });
    if (res.status !== 201) {
      throw new Error(`createFolder failed: ${JSON.stringify(res.body)}`);
    }
    return res.body.data;
  }

  describe('POST /api/v1/folders', () => {
    it('creates a root folder owned by the caller inside the envelope', async () => {
      const res = await request(server())
        .post('/api/v1/folders')
        .set('Authorization', as(alice))
        .send({ name: '  Invoices  ' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        success: true,
        data: {
          id: expect.any(String),
          name: 'Invoices',
          parentId: null,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
        message: null,
        requestId: expect.any(String),
      });
      expect(res.body.data).not.toHaveProperty('userId');

      const stored = await ctx.prisma.folder.findUniqueOrThrow({
        where: { id: res.body.data.id },
      });
      expect(stored.userId).toBe(alice.userId);
    });

    it('creates a nested folder under an owned parent', async () => {
      const parent = await createFolder(alice, 'Parent');
      const res = await request(server())
        .post('/api/v1/folders')
        .set('Authorization', as(alice))
        .send({ name: 'Child', parentId: parent.id });

      expect(res.status).toBe(201);
      expect(res.body.data.parentId).toBe(parent.id);
    });

    it('rejects a parent that belongs to another user with a safe not-found', async () => {
      const bobsFolder = await createFolder(bob, 'Bob private');
      ctx.logs.clear();

      const res = await request(server())
        .post('/api/v1/folders')
        .set('Authorization', as(alice))
        .send({ name: 'Intruder', parentId: bobsFolder.id });

      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'FOLDER_NOT_FOUND');
      expect(ctx.logs.text).toContain('FOLDER_ACCESS_DENIED');
      expect(
        await ctx.prisma.folder.count({ where: { parentId: bobsFolder.id } }),
      ).toBe(0);
    });

    it('rejects an unknown parent', async () => {
      const res = await request(server())
        .post('/api/v1/folders')
        .set('Authorization', as(alice))
        .send({ name: 'Orphan', parentId: randomUUID() });

      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'FOLDER_NOT_FOUND');
    });

    it.each([
      ['empty name', { name: '   ' }],
      ['missing name', {}],
      ['name too long', { name: 'x'.repeat(101) }],
      ['control characters', { name: 'bad\u0000name' }],
      ['non-uuid parent', { name: 'ok', parentId: 'not-a-uuid' }],
      ['forbidden userId', { name: 'ok', userId: randomUUID() }],
      ['non-string name', { name: 42 }],
    ])('rejects %s with VALIDATION_ERROR', async (_label, body) => {
      const res = await request(server())
        .post('/api/v1/folders')
        .set('Authorization', as(alice))
        .send(body);

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    });

    it('rejects unauthenticated requests', async () => {
      const res = await request(server())
        .post('/api/v1/folders')
        .send({ name: 'Anonymous' });

      expect(res.status).toBe(401);
      expectErrorEnvelope(res.body, 'AUTH_UNAUTHORIZED');
    });

    it('enforces the maximum nesting depth', async () => {
      let parentId: string | null = null;
      for (let depth = 1; depth <= 10; depth += 1) {
        const folder = await createFolder(alice, `Level ${depth}`, parentId);
        parentId = folder.id;
      }

      const res = await request(server())
        .post('/api/v1/folders')
        .set('Authorization', as(alice))
        .send({ name: 'Level 11', parentId });

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'FOLDER_DEPTH_EXCEEDED');
    });
  });

  describe('GET /api/v1/folders', () => {
    let listUser: RegisteredUser;
    let root: { id: string };
    let child: { id: string };

    beforeAll(async () => {
      listUser = await registerUser(ctx.app);
      root = await createFolder(listUser, 'Root A');
      await createFolder(listUser, 'Root B');
      child = await createFolder(listUser, 'Child of A', root.id);
    });

    it("lists only the caller's folders", async () => {
      const res = await request(server())
        .get('/api/v1/folders')
        .set('Authorization', as(listUser));

      expect(res.status).toBe(200);
      const names = res.body.data.map((f: { name: string }) => f.name);
      expect(names).toEqual(['Child of A', 'Root A', 'Root B']);
      for (const folder of res.body.data) {
        expect(folder).not.toHaveProperty('userId');
      }
    });

    it('filters root folders with parentId=null', async () => {
      const res = await request(server())
        .get('/api/v1/folders?parentId=null')
        .set('Authorization', as(listUser));

      expect(res.status).toBe(200);
      expect(res.body.data.map((f: { name: string }) => f.name)).toEqual([
        'Root A',
        'Root B',
      ]);
    });

    it('filters children of an owned parent', async () => {
      const res = await request(server())
        .get(`/api/v1/folders?parentId=${root.id}`)
        .set('Authorization', as(listUser));

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(child.id);
    });

    it("refuses to list children of another user's folder", async () => {
      const res = await request(server())
        .get(`/api/v1/folders?parentId=${root.id}`)
        .set('Authorization', as(bob));

      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'FOLDER_NOT_FOUND');
    });

    it('rejects a malformed parentId filter', async () => {
      const res = await request(server())
        .get('/api/v1/folders?parentId=abc')
        .set('Authorization', as(listUser));

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    });
  });

  describe('GET /api/v1/folders/:id', () => {
    it('returns an owned folder and hides foreign ones', async () => {
      const mine = await createFolder(alice, 'Mine');

      const ok = await request(server())
        .get(`/api/v1/folders/${mine.id}`)
        .set('Authorization', as(alice));
      expect(ok.status).toBe(200);
      expect(ok.body.data.id).toBe(mine.id);

      const idor = await request(server())
        .get(`/api/v1/folders/${mine.id}`)
        .set('Authorization', as(bob));
      expect(idor.status).toBe(404);
      expectErrorEnvelope(idor.body, 'FOLDER_NOT_FOUND');
      expect(JSON.stringify(idor.body)).not.toContain('Mine');

      const missing = await request(server())
        .get(`/api/v1/folders/${randomUUID()}`)
        .set('Authorization', as(bob));
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe(idor.body.code);
      expect(missing.body.message).toBe(idor.body.message);
    });

    it('rejects a non-UUID id', async () => {
      const res = await request(server())
        .get('/api/v1/folders/not-a-uuid')
        .set('Authorization', as(alice));

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    });
  });

  describe('PATCH /api/v1/folders/:id', () => {
    it('renames a folder', async () => {
      const folder = await createFolder(alice, 'Old name');

      const res = await request(server())
        .patch(`/api/v1/folders/${folder.id}`)
        .set('Authorization', as(alice))
        .send({ name: 'New name' });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: folder.id, name: 'New name' });
    });

    it('moves a folder under another owned folder and back to the root', async () => {
      const a = await createFolder(alice, 'Move A');
      const b = await createFolder(alice, 'Move B');

      const moved = await request(server())
        .patch(`/api/v1/folders/${b.id}`)
        .set('Authorization', as(alice))
        .send({ parentId: a.id });
      expect(moved.status).toBe(200);
      expect(moved.body.data.parentId).toBe(a.id);

      const toRoot = await request(server())
        .patch(`/api/v1/folders/${b.id}`)
        .set('Authorization', as(alice))
        .send({ parentId: null });
      expect(toRoot.status).toBe(200);
      expect(toRoot.body.data.parentId).toBeNull();
    });

    it('rejects self-parenting', async () => {
      const folder = await createFolder(alice, 'Self');

      const res = await request(server())
        .patch(`/api/v1/folders/${folder.id}`)
        .set('Authorization', as(alice))
        .send({ parentId: folder.id });

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'INVALID_FOLDER');
    });

    it('rejects a cycle A -> B -> C -> A', async () => {
      const a = await createFolder(alice, 'Cycle A');
      const b = await createFolder(alice, 'Cycle B', a.id);
      const c = await createFolder(alice, 'Cycle C', b.id);

      const res = await request(server())
        .patch(`/api/v1/folders/${a.id}`)
        .set('Authorization', as(alice))
        .send({ parentId: c.id });

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'FOLDER_CYCLE_DETECTED');

      const stored = await ctx.prisma.folder.findUniqueOrThrow({
        where: { id: a.id },
      });
      expect(stored.parentId).toBeNull();
    });

    it('rejects moving under a direct child', async () => {
      const a = await createFolder(alice, 'Direct A');
      const b = await createFolder(alice, 'Direct B', a.id);

      const res = await request(server())
        .patch(`/api/v1/folders/${a.id}`)
        .set('Authorization', as(alice))
        .send({ parentId: b.id });

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'FOLDER_CYCLE_DETECTED');
    });

    it("rejects moving into another user's folder", async () => {
      const mine = await createFolder(alice, 'Mine to move');
      const theirs = await createFolder(bob, 'Theirs');

      const res = await request(server())
        .patch(`/api/v1/folders/${mine.id}`)
        .set('Authorization', as(alice))
        .send({ parentId: theirs.id });

      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'FOLDER_NOT_FOUND');
    });

    it("cannot modify another user's folder", async () => {
      const mine = await createFolder(alice, 'Untouchable');

      const res = await request(server())
        .patch(`/api/v1/folders/${mine.id}`)
        .set('Authorization', as(bob))
        .send({ name: 'Hacked' });

      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'FOLDER_NOT_FOUND');
      const stored = await ctx.prisma.folder.findUniqueOrThrow({
        where: { id: mine.id },
      });
      expect(stored.name).toBe('Untouchable');
    });

    it('rejects forbidden fields', async () => {
      const folder = await createFolder(alice, 'Strict');

      const res = await request(server())
        .patch(`/api/v1/folders/${folder.id}`)
        .set('Authorization', as(alice))
        .send({ name: 'ok', userId: bob.userId });

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    });

    it('enforces depth when moving a subtree', async () => {
      // Chain of 9 under the root → depth 9; subtree of height 2 → 11 > 10.
      let parentId: string | null = null;
      for (let depth = 1; depth <= 9; depth += 1) {
        const f = await createFolder(alice, `Deep ${depth}`, parentId);
        parentId = f.id;
      }
      const subtreeRoot = await createFolder(alice, 'Subtree');
      await createFolder(alice, 'Subtree child', subtreeRoot.id);

      const res = await request(server())
        .patch(`/api/v1/folders/${subtreeRoot.id}`)
        .set('Authorization', as(alice))
        .send({ parentId });

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'FOLDER_DEPTH_EXCEEDED');
    });

    it('serialises concurrent conflicting moves so no cycle can form', async () => {
      const a = await createFolder(alice, 'Race A');
      const b = await createFolder(alice, 'Race B');

      const [resA, resB] = await Promise.all([
        request(server())
          .patch(`/api/v1/folders/${a.id}`)
          .set('Authorization', as(alice))
          .send({ parentId: b.id }),
        request(server())
          .patch(`/api/v1/folders/${b.id}`)
          .set('Authorization', as(alice))
          .send({ parentId: a.id }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([200, 400]);

      const [storedA, storedB] = await Promise.all([
        ctx.prisma.folder.findUniqueOrThrow({ where: { id: a.id } }),
        ctx.prisma.folder.findUniqueOrThrow({ where: { id: b.id } }),
      ]);
      expect(storedA.parentId === b.id && storedB.parentId === a.id).toBe(
        false,
      );
    });
  });

  describe('DELETE /api/v1/folders/:id', () => {
    it('moves documents to the root and promotes children instead of deleting them', async () => {
      const parent = await createFolder(alice, 'Delete parent');
      const target = await createFolder(alice, 'Delete me', parent.id);
      const grandchild = await createFolder(alice, 'Grandchild', target.id);
      const doc = await ctx.prisma.document.create({
        data: { userId: alice.userId, folderId: target.id, title: 'Kept' },
      });
      const deletedDoc = await ctx.prisma.document.create({
        data: {
          userId: alice.userId,
          folderId: target.id,
          title: 'Soft deleted',
          status: 'DELETED',
          deletedAt: new Date(),
        },
      });

      const res = await request(server())
        .delete(`/api/v1/folders/${target.id}`)
        .set('Authorization', as(alice));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: { id: target.id, movedDocuments: 2, promotedFolders: 1 },
        message: 'Folder deleted',
        requestId: expect.any(String),
      });

      expect(
        await ctx.prisma.folder.findUnique({ where: { id: target.id } }),
      ).toBeNull();
      const storedDoc = await ctx.prisma.document.findUniqueOrThrow({
        where: { id: doc.id },
      });
      expect(storedDoc.folderId).toBeNull();
      expect(storedDoc.deletedAt).toBeNull();
      const storedDeleted = await ctx.prisma.document.findUniqueOrThrow({
        where: { id: deletedDoc.id },
      });
      expect(storedDeleted.folderId).toBeNull();
      const storedGrandchild = await ctx.prisma.folder.findUniqueOrThrow({
        where: { id: grandchild.id },
      });
      expect(storedGrandchild.parentId).toBe(parent.id);
    });

    it("cannot delete another user's folder nor touch their documents", async () => {
      const theirs = await createFolder(bob, 'Bob keeps this');
      const theirDoc = await ctx.prisma.document.create({
        data: { userId: bob.userId, folderId: theirs.id, title: 'Bob doc' },
      });

      const res = await request(server())
        .delete(`/api/v1/folders/${theirs.id}`)
        .set('Authorization', as(alice));

      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'FOLDER_NOT_FOUND');
      expect(
        await ctx.prisma.folder.findUnique({ where: { id: theirs.id } }),
      ).not.toBeNull();
      const stored = await ctx.prisma.document.findUniqueOrThrow({
        where: { id: theirDoc.id },
      });
      expect(stored.folderId).toBe(theirs.id);
    });

    it('returns not found on a second delete', async () => {
      const folder = await createFolder(alice, 'Twice');
      await request(server())
        .delete(`/api/v1/folders/${folder.id}`)
        .set('Authorization', as(alice))
        .expect(200);

      const res = await request(server())
        .delete(`/api/v1/folders/${folder.id}`)
        .set('Authorization', as(alice));

      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'FOLDER_NOT_FOUND');
    });
  });

  it('refuses a suspended user even with a still-valid access token', async () => {
    const suspended = await registerUser(ctx.app);
    const folder = await createFolder(suspended, 'Before suspension');
    await ctx.prisma.user.update({
      where: { id: suspended.userId },
      data: { status: 'SUSPENDED' },
    });

    const res = await request(server())
      .get(`/api/v1/folders/${folder.id}`)
      .set('Authorization', as(suspended));

    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, 'AUTH_ACCOUNT_SUSPENDED');
  });
});
