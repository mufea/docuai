import request from 'supertest';
import {
  RegisteredUser,
  expectErrorEnvelope,
  registerUser,
} from './utils/auth-helpers';
import {
  createDocument,
  createFolder,
  uploadFile,
} from './utils/document-helpers';
import { TestContext, createTestApp, resetDatabase } from './utils/test-app';

/**
 * Explicit IDOR matrix:
 *
 *   User A ── Document A (READY, in Folder A) ── Folder A
 *   User B ── Document B (READY, in Folder B) ── Folder B
 *
 * Every endpoint is exercised by the *other* user against each resource.
 * Each attempt must be rejected with the same safe not-found the API gives
 * for an unknown id, and must leave the database untouched.
 */
describe('Documents & folders — cross-user access (e2e)', () => {
  let ctx: TestContext;
  let userA: RegisteredUser;
  let userB: RegisteredUser;
  let folderA: { id: string };
  let folderB: { id: string };
  let documentA: { id: string };
  let documentB: { id: string };

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    userA = await registerUser(ctx.app, { name: 'User A' });
    userB = await registerUser(ctx.app, { name: 'User B' });
    folderA = await createFolder(ctx.app, userA, 'Folder A');
    folderB = await createFolder(ctx.app, userB, 'Folder B');
    documentA = await createDocument(ctx.app, userA, {
      title: 'Document A',
      folderId: folderA.id,
    });
    documentB = await createDocument(ctx.app, userB, {
      title: 'Document B',
      folderId: folderB.id,
    });
    await uploadFile(ctx.app, userA, documentA.id);
    await uploadFile(ctx.app, userB, documentB.id);
  });

  afterAll(async () => {
    await ctx.close();
  });

  const server = () => ctx.app.getHttpServer();
  const as = (user: RegisteredUser) => `Bearer ${user.accessToken}`;

  async function snapshot() {
    const [documents, folders] = await Promise.all([
      ctx.prisma.document.findMany({ orderBy: { id: 'asc' } }),
      ctx.prisma.folder.findMany({ orderBy: { id: 'asc' } }),
    ]);
    return JSON.stringify({ documents, folders }, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
  }

  type Attempt = {
    name: string;
    run: (attacker: RegisteredUser, victim: Victim) => request.Test;
    code: string;
  };
  type Victim = { document: { id: string }; folder: { id: string } };

  const attempts: Attempt[] = [
    {
      name: 'GET /documents/:id',
      run: (u, v) =>
        request(server())
          .get(`/api/v1/documents/${v.document.id}`)
          .set('Authorization', as(u)),
      code: 'DOCUMENT_NOT_FOUND',
    },
    {
      name: 'PATCH /documents/:id',
      run: (u, v) =>
        request(server())
          .patch(`/api/v1/documents/${v.document.id}`)
          .set('Authorization', as(u))
          .send({ title: 'Hijacked' }),
      code: 'DOCUMENT_NOT_FOUND',
    },
    {
      name: 'DELETE /documents/:id',
      run: (u, v) =>
        request(server())
          .delete(`/api/v1/documents/${v.document.id}`)
          .set('Authorization', as(u)),
      code: 'DOCUMENT_NOT_FOUND',
    },
    {
      name: 'POST /documents/:id/upload-url',
      run: (u, v) =>
        request(server())
          .post(`/api/v1/documents/${v.document.id}/upload-url`)
          .set('Authorization', as(u))
          .send({
            fileName: 'x.pdf',
            contentType: 'application/pdf',
            fileSize: 100,
          }),
      code: 'DOCUMENT_NOT_FOUND',
    },
    {
      name: 'POST /documents/:id/upload-complete',
      run: (u, v) =>
        request(server())
          .post(`/api/v1/documents/${v.document.id}/upload-complete`)
          .set('Authorization', as(u))
          .send({}),
      code: 'DOCUMENT_NOT_FOUND',
    },
    {
      name: 'GET /documents/:id/download-url',
      run: (u, v) =>
        request(server())
          .get(`/api/v1/documents/${v.document.id}/download-url`)
          .set('Authorization', as(u)),
      code: 'DOCUMENT_NOT_FOUND',
    },
    {
      name: 'POST /documents with foreign folderId',
      run: (u, v) =>
        request(server())
          .post('/api/v1/documents')
          .set('Authorization', as(u))
          .send({ title: 'Planted', folderId: v.folder.id }),
      code: 'FOLDER_NOT_FOUND',
    },
    {
      name: 'GET /documents?folderId=<foreign>',
      run: (u, v) =>
        request(server())
          .get(`/api/v1/documents?folderId=${v.folder.id}`)
          .set('Authorization', as(u)),
      code: 'FOLDER_NOT_FOUND',
    },
    {
      name: 'GET /folders/:id',
      run: (u, v) =>
        request(server())
          .get(`/api/v1/folders/${v.folder.id}`)
          .set('Authorization', as(u)),
      code: 'FOLDER_NOT_FOUND',
    },
    {
      name: 'GET /folders?parentId=<foreign>',
      run: (u, v) =>
        request(server())
          .get(`/api/v1/folders?parentId=${v.folder.id}`)
          .set('Authorization', as(u)),
      code: 'FOLDER_NOT_FOUND',
    },
    {
      name: 'PATCH /folders/:id',
      run: (u, v) =>
        request(server())
          .patch(`/api/v1/folders/${v.folder.id}`)
          .set('Authorization', as(u))
          .send({ name: 'Hijacked' }),
      code: 'FOLDER_NOT_FOUND',
    },
    {
      name: 'DELETE /folders/:id',
      run: (u, v) =>
        request(server())
          .delete(`/api/v1/folders/${v.folder.id}`)
          .set('Authorization', as(u)),
      code: 'FOLDER_NOT_FOUND',
    },
    {
      name: 'POST /folders with foreign parentId',
      run: (u, v) =>
        request(server())
          .post('/api/v1/folders')
          .set('Authorization', as(u))
          .send({ name: 'Planted', parentId: v.folder.id }),
      code: 'FOLDER_NOT_FOUND',
    },
  ];

  describe.each([
    ['User B → User A resources', 'B', 'A'],
    ['User A → User B resources', 'A', 'B'],
  ])('%s', (_label, attackerKey, victimKey) => {
    const attacker = () => (attackerKey === 'A' ? userA : userB);
    const victim = (): Victim =>
      victimKey === 'A'
        ? { document: documentA, folder: folderA }
        : { document: documentB, folder: folderB };

    it.each(attempts.map((a) => [a.name, a] as const))(
      '%s is rejected without side effects',
      async (_name, attempt) => {
        const before = await snapshot();

        const res = await attempt.run(attacker(), victim());

        expect(res.status).toBe(404);
        expectErrorEnvelope(res.body, attempt.code);
        expect(JSON.stringify(res.body)).not.toMatch(
          /Document [AB]|Folder [AB]/,
        );
        expect(await snapshot()).toBe(before);
      },
    );
  });

  it('moving an owned document into a foreign folder and a foreign folder under an owned one are both rejected', async () => {
    const before = await snapshot();

    const moveDoc = await request(server())
      .patch(`/api/v1/documents/${documentB.id}`)
      .set('Authorization', as(userB))
      .send({ folderId: folderA.id });
    expect(moveDoc.status).toBe(404);
    expectErrorEnvelope(moveDoc.body, 'FOLDER_NOT_FOUND');

    const moveFolder = await request(server())
      .patch(`/api/v1/folders/${folderB.id}`)
      .set('Authorization', as(userB))
      .send({ parentId: folderA.id });
    expect(moveFolder.status).toBe(404);
    expectErrorEnvelope(moveFolder.body, 'FOLDER_NOT_FOUND');

    expect(await snapshot()).toBe(before);
  });

  it('listing never leaks the other user’s resources', async () => {
    const docs = await request(server())
      .get('/api/v1/documents')
      .set('Authorization', as(userB));
    expect(docs.body.data.items.map((d: { id: string }) => d.id)).toEqual([
      documentB.id,
    ]);

    const folders = await request(server())
      .get('/api/v1/folders')
      .set('Authorization', as(userB));
    expect(folders.body.data.map((f: { id: string }) => f.id)).toEqual([
      folderB.id,
    ]);
  });

  it('owners still have full access after the attempts', async () => {
    const own = await request(server())
      .get(`/api/v1/documents/${documentA.id}/download-url`)
      .set('Authorization', as(userA));
    expect(own.status).toBe(200);

    const folder = await request(server())
      .get(`/api/v1/folders/${folderB.id}`)
      .set('Authorization', as(userB));
    expect(folder.status).toBe(200);
  });

  it('records an access-denied security event for each cross-user attempt', async () => {
    ctx.logs.clear();
    await request(server())
      .get(`/api/v1/documents/${documentA.id}`)
      .set('Authorization', as(userB));
    await request(server())
      .get(`/api/v1/folders/${folderA.id}`)
      .set('Authorization', as(userB));

    expect(ctx.logs.text).toContain('DOCUMENT_ACCESS_DENIED');
    expect(ctx.logs.text).toContain('FOLDER_ACCESS_DENIED');
    expect(ctx.logs.text).toContain(`"userId":"${userB.userId}"`);
    expect(ctx.logs.text).not.toContain('Document A');
  });
});
