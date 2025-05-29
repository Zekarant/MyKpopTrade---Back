import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { Request } from 'express';

// Configuration du stockage des photos de profil
const profilePictureStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../../../../uploads/profiles');
    
    // Créer le dossier s'il n'existe pas
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // Utiliser l'ID de l'utilisateur + timestamp pour éviter les collisions
    const userId = (req.user as any).id;
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    const extension = path.extname(file.originalname);
    
    cb(null, `${userId}-${uniqueSuffix}${extension}`);
  }
});

// Configuration du stockage de bannières de profil
const profileBannerStorage = multer.diskStorage({
  destination: function(req, file, cb) {
    const uploadDir = path.join(__dirname, '../../../../uploads/banners');

    if(!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    cb(null, uploadDir);
  },
  filename: function(req, file, cb) {
    const userId = (req.user as any).id;
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    const extension = path.extname(file.originalname);

    cb(null, `banner-${userId}-${uniqueSuffix}${extension}`);
  }
});

// Configuration du stockage des images de produits
const productImageStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../../../../uploads/products');
    
    // Créer le dossier s'il n'existe pas
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const userId = (req.user as any).id;
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    const extension = path.extname(file.originalname);
    
    cb(null, `product-${userId}-${uniqueSuffix}${extension}`);
  }
});

// Configuration du stockage des images d'avis
const ratingImageStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../../../../uploads/ratings');
    
    // Créer le dossier s'il n'existe pas
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const userId = (req.user as any).id;
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    const extension = path.extname(file.originalname);
    
    cb(null, `rating-${userId}-${uniqueSuffix}${extension}`);
  }
});

// Filtre pour n'accepter que les images
const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
  
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Format de fichier non supporté. Utilisez JPG, PNG ou GIF.'));
  }
};

// Configurer l'upload avec une taille maximum de 5MB
export const profilePictureUpload = multer({ 
  storage: profilePictureStorage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB
  },
  fileFilter
});

// Upload pour les bannières de profil (plus grande taille max)
export const profileBannerUpload = multer({ 
  storage: profileBannerStorage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB car les bannières sont plus grandes
  },
  fileFilter
});

// Upload pour les images de produits
export const productImagesUpload = multer({ 
  storage: productImageStorage,
  limits: {
    fileSize: 8 * 1024 * 1024, // 8MB
    files: 10
  },
  fileFilter
});

// Upload pour les images d'avis
export const ratingImageUpload = multer({ 
  storage: ratingImageStorage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB
  },
  fileFilter
});