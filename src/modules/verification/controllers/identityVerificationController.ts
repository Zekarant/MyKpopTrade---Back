import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import IdentityVerification from '../../../models/identityVerificationModel';
import User from '../../../models/userModel';
import { secureStoreDocument, deleteSecureDocument } from '../../../commons/services/secureStorageService';
import { sendVerificationResultEmail } from '../../../commons/services/emailService';
import logger from '../../../commons/utils/logger';

/**
 * Soumettre une demande de vérification d'identité
 */
export const submitVerification = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { documentType, consentGiven } = req.body;
  
  if (!req.file) {
    return res.status(400).json({ message: 'Document d\'identité requis' });
  }
  
  // Correction ici : vérification stricte de la valeur de consentGiven
  // Les valeurs form-data sont transmises comme des chaînes, pas comme des booléens
  if (consentGiven !== 'true' && consentGiven !== true) {
    return res.status(400).json({ 
      message: 'Vous devez consentir explicitement à la collecte et au traitement de votre pièce d\'identité après avoir pris connaissance de nos mentions légales' 
    });
  }
  
  if (!['id_card', 'passport', 'driver_license'].includes(documentType)) {
    return res.status(400).json({ message: 'Type de document invalide' });
  }
  
  // Vérifier si l'utilisateur a déjà une demande en cours
  const existingVerification = await IdentityVerification.findOne({
    user: userId,
    status: 'pending'
  });
  
  if (existingVerification) {
    return res.status(409).json({ 
      message: 'Une demande de vérification est déjà en cours de traitement' 
    });
  }
  
  // Stocker le document de manière sécurisée avec floutage
  // Conserver le visage pour l'identification mais flouter les autres données sensibles
  const documentReferenceId = await secureStoreDocument(
    req.file.buffer,
    req.file.mimetype,
    documentType
  );
  
  // Calculer la date d'expiration (30 jours)
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  
  // Créer une nouvelle demande de vérification
  const verification = new IdentityVerification({
    user: userId,
    documentType,
    documentReferenceId,
    expiresAt
  });
  
  await verification.save();
  
  // Journaliser l'action sans détails sensibles
  logger.info(`Demande de vérification d'identité soumise: ${verification._id}`, { 
    userId,
    verificationType: documentType 
  });
  
  return res.status(201).json({
    message: 'Votre demande de vérification d\'identité a été soumise et sera traitée dans les plus brefs délais',
    verification: {
      id: verification._id,
      status: verification.status,
      documentType: verification.documentType,
      submittedAt: verification.submittedAt
    }
  });
});

/**
 * Vérifier le statut d'une demande de vérification
 */
export const checkVerificationStatus = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  
  // Récupérer la dernière demande de vérification de l'utilisateur
  const verification = await IdentityVerification.findOne({ user: userId })
    .sort({ submittedAt: -1 });
  
  if (!verification) {
    return res.status(404).json({ 
      message: 'Aucune demande de vérification trouvée' 
    });
  }
  
  // Récupérer le statut de vérification de l'utilisateur
  const user = await User.findById(userId, {
    isIdentityVerified: 1,
    identityVerifiedAt: 1,
    verificationLevel: 1
  });
  
  return res.status(200).json({
    verification: {
      id: verification._id,
      status: verification.status,
      documentType: verification.documentType,
      submittedAt: verification.submittedAt,
      processedAt: verification.processedAt,
      rejectionReason: verification.rejectionReason
    },
    userVerification: {
      isVerified: user?.isIdentityVerified || false,
      verifiedAt: user?.identityVerifiedAt,
      level: user?.verificationLevel || 'none'
    }
  });
});

/**
 * Approuver une demande de vérification (accès administrateur)
 */
export const approveVerification = asyncHandler(async (req: Request, res: Response) => {
  // Utiliser id ou verificationId selon ce qui est disponible
  const verificationId = req.params.id || req.params.verificationId;
  const adminId = (req.user as any).id;
  
  // Ajouter une vérification de valeur
  if (!verificationId) {
    return res.status(400).json({ message: 'ID de vérification requis' });
  }
  
  // Log pour déboguer
  logger.debug(`Tentative d'approbation de la vérification: ${verificationId}`, { adminId });
  
  // Vérifier les droits d'administration via le middleware donc pas besoin de vérifier à nouveau ici
  
  let verification;
  try {
    // Utiliser mongoose pour trouver par ID en validant d'abord le format
    verification = await IdentityVerification.findById(verificationId);
  } catch (error) {
    logger.error(`Erreur lors de la recherche de la vérification: ${verificationId}`, { error });
    return res.status(400).json({ message: 'ID de vérification invalide' });
  }
  
  if (!verification) {
    logger.warn(`Vérification non trouvée: ${verificationId}`);
    return res.status(404).json({ message: 'Demande de vérification non trouvée' });
  }
  
  if (verification.status !== 'pending') {
    return res.status(400).json({ message: 'Cette demande a déjà été traitée' });
  }
  
  // Approuver la demande
  verification.status = 'approved';
  verification.processedAt = new Date();
  verification.processedBy = adminId;
  await verification.save();
  
  // Mettre à jour le statut de vérification de l'utilisateur
  await User.findByIdAndUpdate(verification.user, {
    isIdentityVerified: true,
    identityVerifiedAt: new Date(),
    verificationLevel: 'complete'
  });
  
  // Envoyer un email à l'utilisateur
  const user = await User.findById(verification.user);
  if (user?.email) {
    await sendVerificationResultEmail(user.email, true);
  }
  
  // Supprimer le document d'identité après approbation pour minimiser les risques
  try {
    deleteSecureDocument(verification.documentReferenceId);
  } catch (error) {
    logger.error('Erreur lors de la suppression du document d\'identité', { error });
  }
  
  logger.info(`Demande de vérification approuvée: ${verificationId}`, { 
    adminId, 
    userId: verification.user 
  });
  
  return res.status(200).json({
    message: 'Demande de vérification approuvée avec succès'
  });
});

/**
 * Rejeter une demande de vérification (accès administrateur)
 */
export const rejectVerification = asyncHandler(async (req: Request, res: Response) => {
  // Utiliser id ou verificationId selon ce qui est disponible
  const verificationId = req.params.id || req.params.verificationId;
  const adminId = (req.user as any).id;
  const { reason } = req.body;
  
  if (!reason) {
    return res.status(400).json({ message: 'Motif de rejet requis' });
  }
  
  // Vérifier les droits d'administration via le middleware (optionnel ici)
  
  let verification;
  try {
    // Utiliser mongoose pour trouver par ID en validant d'abord le format
    verification = await IdentityVerification.findById(verificationId);
  } catch (error) {
    logger.error(`Erreur lors de la recherche de la vérification: ${verificationId}`, { error });
    return res.status(400).json({ message: 'ID de vérification invalide' });
  }
  
  if (!verification) {
    logger.warn(`Vérification non trouvée: ${verificationId}`);
    return res.status(404).json({ message: 'Demande de vérification non trouvée' });
  }
  
  if (verification.status !== 'pending') {
    return res.status(400).json({ message: 'Cette demande a déjà été traitée' });
  }
  
  // Rejeter la demande
  verification.status = 'rejected';
  verification.processedAt = new Date();
  verification.processedBy = adminId;
  verification.rejectionReason = reason;
  await verification.save();
  
  // Envoyer un email à l'utilisateur
  const user = await User.findById(verification.user);
  if (user?.email) {
    await sendVerificationResultEmail(user.email, false, reason);
  }
  
  // Supprimer le document d'identité après rejet
  try {
    deleteSecureDocument(verification.documentReferenceId);
  } catch (error) {
    logger.error('Erreur lors de la suppression du document d\'identité', { error });
  }
  
  logger.info(`Demande de vérification rejetée: ${verificationId}`, { 
    adminId, 
    userId: verification.user,
    reason
  });
  
  return res.status(200).json({
    message: 'Demande de vérification rejetée'
  });
});

/**
 * Liste des demandes de vérification en attente (accès administrateur)
 */
export const getPendingVerifications = asyncHandler(async (req: Request, res: Response) => {
  const adminId = (req.user as any).id;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  
  // Vérifier les droits d'administration
  const admin = await User.findById(adminId);
  if (!admin || admin.role !== 'admin') {
    return res.status(403).json({ message: 'Accès non autorisé' });
  }
  
  const [verifications, total] = await Promise.all([
    IdentityVerification.find({ status: 'pending' })
      .populate('user', 'username email')
      .sort({ submittedAt: 1 }) // Plus anciennes d'abord
      .skip((page - 1) * limit)
      .limit(limit),
    IdentityVerification.countDocuments({ status: 'pending' })
  ]);
  
  return res.status(200).json({
    verifications,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  });
});

/**
 * Annuler une demande de vérification
 */
export const cancelVerification = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  
  const verification = await IdentityVerification.findOne({
    user: userId,
    status: 'pending'
  });
  
  if (!verification) {
    return res.status(404).json({ 
      message: 'Aucune demande de vérification en cours trouvée' 
    });
  }
  
  // Supprimer le document d'identité
  try {
    deleteSecureDocument(verification.documentReferenceId);
  } catch (error) {
    logger.error('Erreur lors de la suppression du document d\'identité', { error });
  }
  
  // Supprimer la demande
  await verification.deleteOne();
  
  logger.info(`Demande de vérification annulée par l'utilisateur: ${verification._id}`, { userId });
  
  return res.status(200).json({
    message: 'Votre demande de vérification a été annulée avec succès'
  });
});