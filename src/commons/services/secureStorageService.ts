import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import logger from '../utils/logger';

// Clé de chiffrement à stocker en sécurité dans les variables d'environnement
const rawKey = process.env.ENCRYPTION_KEY || '';
// Créer une clé de longueur fixe (32 octets) pour AES-256
const ENCRYPTION_KEY = crypto
  .createHash('sha256')
  .update(rawKey)
  .digest();
// Vecteur d'initialisation généré à chaque chiffrement
const IV_LENGTH = 16;

// Constantes
const SECURE_STORAGE_PATH = process.env.SECURE_STORAGE_PATH || path.join(process.cwd(), 'secure_storage');
const DOCUMENT_RETENTION_DAYS = parseInt(process.env.DOCUMENT_RETENTION_DAYS || '30');

/**
 * Vérifie et crée si nécessaire le répertoire de stockage sécurisé
 */
const ensureStorageDirectory = (): void => {
  if (!fs.existsSync(SECURE_STORAGE_PATH)) {
    // Créer avec des permissions restreintes
    fs.mkdirSync(SECURE_STORAGE_PATH, { recursive: true, mode: 0o700 });
    
    // Sous Linux, on pourrait ajouter
    if (process.platform !== 'win32') {
      const { execSync } = require('child_process');
      // Restreindre l'accès au dossier
      execSync(`chmod 700 ${SECURE_STORAGE_PATH}`);
    }
  }
};

/**
 * Version simplifiée de floutage des zones sensibles basée uniquement sur des positions prédéfinies
 * Sans utiliser TensorFlow pour la détection de visage
 */
export const blurSensitiveAreas = async (
  imageBuffer: Buffer, 
  documentType: string
): Promise<Buffer> => {
  try {
    // Convertir l'image pour analyse
    const image = sharp(imageBuffer);
    const metadata = await image.metadata();
    
    const width = metadata.width || 800;
    const height = metadata.height || 600;
    
    // Zones à flouter selon le type de document (positions approximatives)
    const blurRegions: Array<{x: number, y: number, width: number, height: number}> = [];
    
    if (documentType === 'id_card') {
      // Flouter la zone d'adresse
      blurRegions.push({
        x: Math.floor(width * 0.3),
        y: Math.floor(height * 0.5),
        width: Math.floor(width * 0.6),
        height: Math.floor(height * 0.2)
      });
      
      // Flouter la zone du numéro de carte (en haut)
      blurRegions.push({
        x: Math.floor(width * 0.6),
        y: Math.floor(height * 0.1),
        width: Math.floor(width * 0.35),
        height: Math.floor(height * 0.1)
      });
    } else if (documentType === 'passport') {
      // Flouter la MRZ (zone lisible par machine)
      blurRegions.push({
        x: 0,
        y: Math.floor(height * 0.8),
        width: width,
        height: Math.floor(height * 0.2)
      });
      
      // Flouter le numéro de passeport
      blurRegions.push({
        x: Math.floor(width * 0.5),
        y: Math.floor(height * 0.3),
        width: Math.floor(width * 0.45),
        height: Math.floor(height * 0.1)
      });
    } else if (documentType === 'driver_license') {
      // Flouter l'adresse
      blurRegions.push({
        x: Math.floor(width * 0.4),
        y: Math.floor(height * 0.6),
        width: Math.floor(width * 0.55),
        height: Math.floor(height * 0.15)
      });
      
      // Flouter le numéro de permis
      blurRegions.push({
        x: Math.floor(width * 0.5),
        y: Math.floor(height * 0.3),
        width: Math.floor(width * 0.45),
        height: Math.floor(height * 0.1)
      });
    }
    
    // Si aucune région à flouter, retourner l'image originale
    if (blurRegions.length === 0) {
      return imageBuffer;
    }
    
    // Appliquer le floutage à chaque région
    let processedImage = sharp(imageBuffer);
    
    // Créer un composite avec les zones floutées
    const overlays = await Promise.all(blurRegions.map(async (region) => {
      // Extraire et flouter la région
      const extract = await sharp(imageBuffer)
        .extract({
          left: region.x,
          top: region.y,
          width: region.width,
          height: region.height
        })
        .blur(20)
        .toBuffer();
        
      return {
        input: extract,
        top: region.y,
        left: region.x
      };
    }));
    
    // Appliquer les zones floutées
    processedImage = processedImage.composite(overlays);
    
    return processedImage.toBuffer();
  } catch (error) {
    logger.error('Erreur pendant le floutage des zones sensibles', { error });
    // En cas d'erreur, retourner l'image originale
    return imageBuffer;
  }
};

/**
 * Chiffre et stocke un fichier de manière sécurisée
 * @param fileBuffer Buffer contenant le fichier
 * @param fileType Type MIME du fichier
 * @param documentType Type de document d'identité
 * @returns Identifiant de référence du document stocké
 */
export const secureStoreDocument = async (
  fileBuffer: Buffer, 
  fileType: string,
  documentType: string
): Promise<string> => {
  if (!ENCRYPTION_KEY) {
    throw new Error('Clé de chiffrement non configurée');
  }

  ensureStorageDirectory();
  
  // Appliquer le floutage si c'est une image
  let processedBuffer = fileBuffer;
  if (fileType.startsWith('image/')) {
    try {
      processedBuffer = await blurSensitiveAreas(fileBuffer, documentType);
    } catch (error) {
      logger.error('Erreur pendant le floutage, utilisation de l\'image originale', { error });
    }
  }

  // Génération d'un IV aléatoire
  const iv = crypto.randomBytes(IV_LENGTH);
  
  // Chiffrement du document
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let encrypted = cipher.update(processedBuffer);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  
  // Génération d'un identifiant unique
  const fileId = uuidv4();
  
  // Stocker les métadonnées
  const metadata = {
    id: fileId,
    type: fileType,
    documentType,
    iv: iv.toString('hex'),
    blurred: fileBuffer !== processedBuffer,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + DOCUMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  };
  
  // Écrire le fichier chiffré et les métadonnées
  const encryptedFilePath = path.join(SECURE_STORAGE_PATH, `${fileId}.enc`);
  const metadataPath = path.join(SECURE_STORAGE_PATH, `${fileId}.meta`);
  
  fs.writeFileSync(encryptedFilePath, encrypted);
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  
  logger.info('Document stocké de façon sécurisée avec zones sensibles floutées', {
    documentType,
    blurred: fileBuffer !== processedBuffer
  });
  
  return fileId;
};

/**
 * Récupère un document stocké de manière sécurisée
 * @param fileId Identifiant du document
 * @returns Le document déchiffré et ses métadonnées
 */
export const retrieveSecureDocument = (fileId: string): { buffer: Buffer, metadata: any } => {
  if (!ENCRYPTION_KEY) {
    throw new Error('Clé de chiffrement non configurée');
  }
  
  const encryptedFilePath = path.join(SECURE_STORAGE_PATH, `${fileId}.enc`);
  const metadataPath = path.join(SECURE_STORAGE_PATH, `${fileId}.meta`);
  
  if (!fs.existsSync(encryptedFilePath) || !fs.existsSync(metadataPath)) {
    throw new Error('Document non trouvé');
  }
  
  // Lire les métadonnées
  const metadataRaw = fs.readFileSync(metadataPath, 'utf8');
  const metadata = JSON.parse(metadataRaw);
  
  // Vérifier si le document a expiré
  const expiryDate = new Date(metadata.expiresAt);
  if (expiryDate < new Date()) {
    throw new Error('Document expiré');
  }
  
  // Lire le fichier chiffré
  const encrypted = fs.readFileSync(encryptedFilePath);
  
  // Déchiffrer le fichier
  const iv = Buffer.from(metadata.iv, 'hex');
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    Buffer.from(ENCRYPTION_KEY),
    iv
  );
  
  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  
  return { buffer: decrypted, metadata };
};

/**
 * Supprime définitivement un document stocké de manière sécurisée
 * @param fileId Identifiant du document
 */
export const deleteSecureDocument = (fileId: string): void => {
  const encryptedFilePath = path.join(SECURE_STORAGE_PATH, `${fileId}.enc`);
  const metadataPath = path.join(SECURE_STORAGE_PATH, `${fileId}.meta`);
  
  // Supprimer les fichiers s'ils existent
  if (fs.existsSync(encryptedFilePath)) {
    fs.unlinkSync(encryptedFilePath);
  }
  
  if (fs.existsSync(metadataPath)) {
    fs.unlinkSync(metadataPath);
  }
};

/**
 * Tâche de nettoyage des documents expirés
 * À exécuter régulièrement via un cron job
 */
export const cleanExpiredDocuments = (): void => {
  ensureStorageDirectory();
  
  // Lister tous les fichiers de métadonnées
  const files = fs.readdirSync(SECURE_STORAGE_PATH)
    .filter(file => file.endsWith('.meta'));
  
  const now = new Date();
  
  files.forEach(file => {
    const metadataPath = path.join(SECURE_STORAGE_PATH, file);
    const metadataRaw = fs.readFileSync(metadataPath, 'utf8');
    const metadata = JSON.parse(metadataRaw);
    
    // Vérifier si le document a expiré
    const expiryDate = new Date(metadata.expiresAt);
    if (expiryDate < now) {
      // Supprimer le document expiré
      deleteSecureDocument(metadata.id);
    }
  });
};