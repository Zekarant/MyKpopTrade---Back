import { Types } from 'mongoose';
import Block from '../../../models/blockModel';
import User from '../../../models/userModel';
import Follow from '../../follows/model';
import { HttpError } from '../../../commons/utils/httpError';

type UserIdLike = string | Types.ObjectId;

const DUPLICATE_KEY_ERROR = 11000;

export const BLOCKED_ERROR_CODE = 'BLOCKED';

/**
 * Interaction refusée parce que l'un des deux membres a bloqué l'autre. Le
 * message ne dit pas qui a bloqué qui : le bloqué n'a pas à l'apprendre ici.
 */
export class BlockedInteractionError extends HttpError {
  constructor() {
    super(403, 'Action impossible : l\'un de vous deux a bloqué l\'autre.', BLOCKED_ERROR_CODE);
  }
}

/** Situation de blocage entre le membre connecté et un autre membre. */
export interface BlockStatus {
  /** Un blocage existe, dans un sens ou dans l'autre. */
  isBlocked: boolean;
  /** C'est le membre connecté qui a bloqué l'autre (il peut donc débloquer). */
  blockedByMe: boolean;
}

const eitherDirection = (userA: UserIdLike, userB: UserIdLike) => ({
  $or: [
    { blocker: userA, blocked: userB },
    { blocker: userB, blocked: userA }
  ]
});

/** Vrai si `userA` a bloqué `userB` ou l'inverse. */
export async function isBlockedBetween(userA: UserIdLike, userB: UserIdLike): Promise<boolean> {
  return (await Block.exists(eitherDirection(userA, userB))) !== null;
}

/**
 * Garde commune à toutes les interactions entre deux membres (message, offre,
 * abonnement, avis…).
 * @throws BlockedInteractionError (403, code BLOCKED)
 */
export async function assertNotBlocked(userA: UserIdLike, userB: UserIdLike): Promise<void> {
  if (await isBlockedBetween(userA, userB)) {
    throw new BlockedInteractionError();
  }
}

/** Même garde, appliquée à chaque autre participant d'une conversation. */
export async function assertNotBlockedInConversation(userId: string, participants: UserIdLike[]): Promise<void> {
  for (const participant of participants) {
    if (String(participant) !== userId) {
      await assertNotBlocked(userId, participant);
    }
  }
}

export async function getBlockStatus(viewerId: UserIdLike, otherId: UserIdLike): Promise<BlockStatus> {
  const blocks = await Block.find(eitherDirection(viewerId, otherId)).select('blocker').lean();
  return {
    isBlocked: blocks.length > 0,
    blockedByMe: blocks.some((block) => String(block.blocker) === String(viewerId))
  };
}

/**
 * Bloque un membre. Idempotent : bloquer deux fois ne change rien.
 * Coupe aussi les abonnements dans les deux sens, sinon le bloqué continuerait
 * de suivre l'activité de celui qui l'a bloqué (et inversement).
 * @throws HttpError 400 sur soi-même, 404 si le membre n'existe pas
 */
export async function blockUser(blockerId: string, blockedId: string): Promise<void> {
  if (blockerId === blockedId) {
    throw new HttpError(400, 'Vous ne pouvez pas vous bloquer vous-même', 'CANNOT_BLOCK_SELF');
  }
  if (!(await User.exists({ _id: blockedId }))) {
    throw new HttpError(404, 'Utilisateur introuvable');
  }

  const alreadyBlocked = await Block.exists({ blocker: blockerId, blocked: blockedId });
  if (!alreadyBlocked) {
    try {
      await Block.create({ blocker: blockerId, blocked: blockedId });
    } catch (error) {
      // Double clic simultané : l'index unique a refusé le second blocage.
      const isDuplicate = typeof error === 'object' && error !== null && 'code' in error && error.code === DUPLICATE_KEY_ERROR;
      if (!isDuplicate) throw error;
    }
  }

  await Follow.deleteMany({
    $or: [
      { follower: blockerId, following: blockedId },
      { follower: blockedId, following: blockerId }
    ]
  });
}

/** Débloque un membre. Idempotent : débloquer un membre non bloqué ne fait rien. */
export async function unblockUser(blockerId: string, blockedId: string): Promise<void> {
  await Block.deleteOne({ blocker: blockerId, blocked: blockedId });
}

type BlockedUserRef = { _id: Types.ObjectId; username: string; profilePicture?: string };

/** Membres bloqués par `blockerId`, du plus récent au plus ancien. */
export async function listBlockedUsers(blockerId: string, page: number, limit: number) {
  const filter = { blocker: blockerId };
  const [blocks, totalItems] = await Promise.all([
    Block.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate<{ blocked: BlockedUserRef | null }>('blocked', 'username profilePicture')
      .lean(),
    Block.countDocuments(filter)
  ]);

  return {
    // Un compte supprimé définitivement laisse un `null` après populate.
    blockedUsers: blocks
      .filter((block) => block.blocked !== null)
      .map((block) => ({
        _id: block.blocked!._id,
        username: block.blocked!.username,
        profilePicture: block.blocked!.profilePicture,
        blockedAt: block.createdAt
      })),
    pagination: {
      page,
      limit,
      totalItems,
      totalPages: Math.ceil(totalItems / limit)
    }
  };
}
