import AuditLog from '../../models/auditLogModel';
import logger from './logger';
import mongoose from 'mongoose';

type TargetType = 'user' | 'product' | 'post' | 'report' | 'verification' | 'system' | 'dispute' | 'payment';

/**
 * Crée une entrée d'audit log côté plateforme.
 *
 * Ne lève jamais : un échec d'audit ne doit pas faire échouer l'opération
 * métier. Mais on log un warn pour signaler la perte de trace.
 */
export async function recordAuditLog(params: {
  adminId: string | mongoose.Types.ObjectId;
  action: string;
  targetType: TargetType;
  targetId?: string | mongoose.Types.ObjectId;
  details?: string;
  metadata?: Record<string, any>;
}): Promise<void> {
  try {
    await AuditLog.create({
      admin: params.adminId,
      action: params.action,
      targetType: params.targetType,
      targetId: params.targetId,
      details: params.details,
      metadata: params.metadata
    });
  } catch (error) {
    logger.warn('Échec écriture AuditLog', {
      action: params.action,
      targetType: params.targetType,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
