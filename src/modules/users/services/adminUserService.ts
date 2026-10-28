import mongoose from 'mongoose';
import User, { IUser } from '../../../models/userModel';
import Product from '../../../models/productModel';
import Report from '../../../models/reportModel';
import Dispute from '../../../models/disputeModel';
import { recordAuditLog } from '../../../commons/utils/auditService';
import { dispatchAdminAlert } from '../../../commons/services/adminAlertService';
import { escapeRegex } from '../../../commons/utils/escapeRegex';
import { badRequest, notFound } from '../../../commons/utils/httpError';
import { PageRequest, paginationMeta } from '../../../commons/utils/pagination';

export const USER_ROLES: IUser['role'][] = ['user', 'moderator', 'admin'];
const LISTABLE_STATUSES: IUser['accountStatus'][] = ['active', 'suspended', 'deleted'];

export const USER_LIST_FIELDS =
  'username email profilePicture role accountStatus suspension sanctions isEmailVerified isIdentityVerified createdAt lastLogin';

const USER_DETAIL_FIELDS =
  'username email profilePicture role accountStatus suspension sanctions adminNotes ' +
  'bio location isEmailVerified isIdentityVerified createdAt lastLogin statistics';

const ADMIN_NOTE_MAX_LENGTH = 2000;

export const USER_NOT_FOUND_MESSAGE = 'Utilisateur non trouvé';

export interface UserListFilters {
  search?: string;
  role?: string;
  status?: string;
}

const isRole = (value: unknown): value is IUser['role'] =>
  typeof value === 'string' && (USER_ROLES as string[]).includes(value);

/** Filtre Mongo de la liste admin ; un rôle ou statut inconnu est ignoré. */
export function buildUserListFilter({ search, role, status }: UserListFilters): mongoose.QueryFilter<IUser> {
  const filter: mongoose.QueryFilter<IUser> = {};

  if (search) {
    const pattern = escapeRegex(search);
    filter.$or = [
      { username: { $regex: pattern, $options: 'i' } },
      { email: { $regex: pattern, $options: 'i' } }
    ];
  }
  if (isRole(role)) {
    filter.role = role;
  }
  if (status && (LISTABLE_STATUSES as string[]).includes(status)) {
    filter.accountStatus = status as IUser['accountStatus'];
  }
  return filter;
}

export async function listUsers(filters: UserListFilters, pageRequest: PageRequest) {
  const filter = buildUserListFilter(filters);
  const [users, total] = await Promise.all([
    User.find(filter)
      .select(USER_LIST_FIELDS)
      .sort({ createdAt: -1 })
      .skip(pageRequest.skip)
      .limit(pageRequest.limit)
      .lean(),
    User.countDocuments(filter)
  ]);

  return { users, pagination: paginationMeta(pageRequest, total) };
}

/** Fiche admin d'un membre et compteurs de son activité. */
export async function getUserDetail(userId: string) {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    throw badRequest('ID d\'utilisateur invalide');
  }

  const user = await User.findById(userId)
    .select(USER_DETAIL_FIELDS)
    .populate('adminNotes.author', 'username')
    .populate('sanctions.by', 'username')
    .lean();
  if (!user) {
    throw notFound(USER_NOT_FOUND_MESSAGE);
  }

  const [listings, reportsAgainst, reportsFiled, disputes] = await Promise.all([
    Product.countDocuments({ seller: userId }),
    Report.countDocuments({ targetType: 'user', targetId: userId }),
    Report.countDocuments({ reporter: userId }),
    Dispute.countDocuments({ $or: [{ buyer: userId }, { seller: userId }] })
  ]);

  return { user, activity: { listings, reportsAgainst, reportsFiled, disputes } };
}

/** Ajoute une note interne et renvoie les notes à jour. */
export async function addUserNote({ adminId, userId, content }: { adminId: string; userId: string; content: unknown }) {
  if (typeof content !== 'string' || !content.trim()) {
    throw badRequest('Le contenu de la note est obligatoire');
  }

  const note = {
    content: content.trim().slice(0, ADMIN_NOTE_MAX_LENGTH),
    author: adminId,
    createdAt: new Date()
  };

  const user = await User.findByIdAndUpdate(
    userId,
    { $push: { adminNotes: note } },
    { returnDocument: 'after', runValidators: false }
  )
    .select('adminNotes username')
    .populate('adminNotes.author', 'username')
    .lean();
  if (!user) {
    throw notFound(USER_NOT_FOUND_MESSAGE);
  }

  await recordAuditLog({
    adminId,
    action: 'add_user_note',
    targetType: 'user',
    targetId: userId,
    details: `Note interne ajoutée sur ${user.username}`
  });

  return user.adminNotes;
}

/** Retire une note interne et renvoie les notes restantes. */
export async function deleteUserNote({ adminId, userId, noteId }: { adminId: string; userId: string; noteId: string }) {
  const user = await User.findByIdAndUpdate(
    userId,
    { $pull: { adminNotes: { _id: noteId } } },
    { returnDocument: 'after', runValidators: false }
  )
    .select('adminNotes username')
    .populate('adminNotes.author', 'username')
    .lean();
  if (!user) {
    throw notFound(USER_NOT_FOUND_MESSAGE);
  }

  await recordAuditLog({
    adminId,
    action: 'delete_user_note',
    targetType: 'user',
    targetId: userId,
    details: `Note interne supprimée sur ${user.username}`
  });

  return user.adminNotes;
}

export async function changeUserRole({ adminId, userId, role }: { adminId: string; userId: string; role: unknown }) {
  if (!isRole(role)) {
    throw badRequest('Rôle invalide');
  }

  const user = await User.findById(userId);
  if (!user) {
    throw notFound(USER_NOT_FOUND_MESSAGE);
  }

  const oldRole = user.role;
  user.role = role;
  await user.save({ validateBeforeSave: false });

  await recordAuditLog({
    adminId,
    action: 'change_role',
    targetType: 'user',
    targetId: user._id,
    details: `Rôle de ${user.username} changé: ${oldRole} → ${role}`
  });

  dispatchAdminAlert({
    event: 'user.role_changed',
    severity: role === 'user' ? 'info' : 'warning',
    title: `Rôle modifié : ${user.username}`,
    summary: `${oldRole} → ${role}`,
    adminTab: 'users',
    fields: [
      { name: 'Ancien rôle', value: oldRole, inline: true },
      { name: 'Nouveau rôle', value: role, inline: true }
    ],
    data: { userId, oldRole, newRole: role }
  });

  return user;
}
