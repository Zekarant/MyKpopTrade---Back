import mongoose from 'mongoose';
import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser } from '../../../../tests/helpers/fixtures';
import User from '../../../../models/userModel';
import AuditLog from '../../../../models/auditLogModel';
import { HttpError } from '../../../../commons/utils/httpError';
import { liftExpiredSuspensions, reactivateUser, suspendUser } from '../userSanctionService';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('userSanctionService (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  const adminId = () => new mongoose.Types.ObjectId().toString();

  it('suspend pour la durée demandée, historise la sanction et l\'audite', async () => {
    const member = await createTestUser();
    const before = Date.now();

    const user = await suspendUser({ adminId: adminId(), userId: String(member._id), reason: '  Fraude avérée  ', durationDays: 30 });

    expect(user.accountStatus).toBe('suspended');
    expect(user.suspension?.reason).toBe('Fraude avérée');
    const untilMs = user.suspension!.until!.getTime() - before;
    expect(Math.round(untilMs / MS_PER_DAY)).toBe(30);
    expect(user.sanctions?.map((s) => s.action)).toEqual(['suspend']);
    expect(await AuditLog.countDocuments({ action: 'suspend_user' })).toBe(1);
  });

  it('suspend définitivement sans durée', async () => {
    const member = await createTestUser();

    const user = await suspendUser({ adminId: adminId(), userId: String(member._id), reason: 'Récidive', durationDays: undefined });

    expect(user.suspension?.until).toBeUndefined();
  });

  it.each([
    ['un motif trop court', { reason: 'abc', durationDays: 7 }],
    ['une durée hors liste', { reason: 'Motif valable', durationDays: 2 }]
  ])('refuse %s (400)', async (_label, input) => {
    const member = await createTestUser();

    await expect(suspendUser({ adminId: adminId(), userId: String(member._id), ...input }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect((await User.findById(member._id))?.accountStatus).toBe('active');
  });

  it('refuse de sanctionner un administrateur ou un membre inconnu', async () => {
    const admin = await createTestUser({ role: 'admin' });

    // Chaque appel est attendu aussitôt : une promesse rejetée avant d'être
    // attendue serait signalée comme rejet non géré, et le test deviendrait aléatoire.
    await expect(
      suspendUser({ adminId: adminId(), userId: String(admin._id), reason: 'Motif valable', durationDays: 7 })
    ).rejects.toMatchObject({ statusCode: 403, code: 'ADMIN_PROTECTED' });
    await expect(
      reactivateUser({ adminId: adminId(), userId: new mongoose.Types.ObjectId().toString() })
    ).rejects.toBeInstanceOf(HttpError);
  });

  it('réactive un membre et efface la suspension en cours', async () => {
    const member = await createTestUser();
    await suspendUser({ adminId: adminId(), userId: String(member._id), reason: 'Motif valable', durationDays: 7 });

    const user = await reactivateUser({ adminId: adminId(), userId: String(member._id), reason: 'Erreur de modération' });

    expect(user.accountStatus).toBe('active');
    expect(user.suspension).toBeUndefined();
    expect(user.sanctions?.map((s) => [s.action, s.reason])).toEqual([
      ['suspend', 'Motif valable'],
      ['unsuspend', 'Erreur de modération']
    ]);
  });

  it('lève seulement les suspensions arrivées à échéance', async () => {
    const expired = await createTestUser({
      accountStatus: 'suspended',
      suspension: { reason: 'Spam', until: new Date(Date.now() - MS_PER_DAY), suspendedAt: new Date() }
    });
    const ongoing = await createTestUser({
      accountStatus: 'suspended',
      suspension: { reason: 'Spam', until: new Date(Date.now() + MS_PER_DAY), suspendedAt: new Date() }
    });
    const permanent = await createTestUser({
      accountStatus: 'suspended',
      suspension: { reason: 'Fraude', suspendedAt: new Date() }
    });

    const lifted = await liftExpiredSuspensions();

    expect(lifted).toBe(1);
    expect((await User.findById(expired._id))?.accountStatus).toBe('active');
    expect((await User.findById(ongoing._id))?.accountStatus).toBe('suspended');
    expect((await User.findById(permanent._id))?.accountStatus).toBe('suspended');
  });
});
