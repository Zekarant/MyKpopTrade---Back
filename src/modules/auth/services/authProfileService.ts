import User from '../../../models/userModel';
import { validateEmail, validatePhoneNumber, validateUsername } from '../../../commons/utils/validators';
import { sendVerificationEmail } from '../../../commons/services/emailService';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';

async function loadUserOr404(userId: string) {
  const user = await User.findById(userId);
  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }
  return user;
}

async function verifyPasswordIfProvided(userId: string, confirmPassword?: string) {
  if (!confirmPassword) return;

  const userWithPassword = await User.findById(userId).select('+password');

  if (!userWithPassword) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  if (!userWithPassword.password) return;

  try {
    const isPasswordValid = await userWithPassword.comparePassword(confirmPassword);
    if (!isPasswordValid) {
      throw new HttpError(401, 'Mot de passe de confirmation incorrect');
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    logger.error('Erreur lors de la vérification du mot de passe:', error);
    throw new HttpError(500, 'Erreur lors de la vérification du mot de passe');
  }
}

export async function getPublicProfileData(userId: string) {
  const user = await User.findById(userId, {
    password: 0,
    emailVerificationToken: 0,
    emailVerificationExpires: 0,
    passwordResetToken: 0,
    passwordResetExpires: 0,
    phoneVerificationCode: 0,
    phoneVerificationExpires: 0
  });

  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  return user;
}

export async function updateProfileData(userId: string, body: any) {
  const user = await loadUserOr404(userId);

  const {
    username,
    email,
    paypalEmail,
    phoneNumber,
    bio,
    location,
    socialLinks,
    preferences
  } = body;

  let emailUpdated = false;
  let phoneNumberUpdated = false;

  if (username && username !== user.username) {
    if (!validateUsername(username)) {
      throw new HttpError(400, 'Nom d\'utilisateur invalide (3-30 caractères, alphanumérique + _-)');
    }
    const existing = await User.findOne({ username, _id: { $ne: userId } });
    if (existing) {
      throw new HttpError(400, 'Ce nom d\'utilisateur est déjà utilisé');
    }
    user.username = username;
  }

  if (email && email !== user.email) {
    if (!validateEmail(email)) {
      throw new HttpError(400, 'Format d\'email invalide');
    }
    const existing = await User.findOne({ email, _id: { $ne: userId } });
    if (existing) {
      throw new HttpError(400, 'Cet email est déjà utilisé');
    }
    user.email = email;
    user.isEmailVerified = false;
    const verificationToken = user.generateVerificationToken();
    await user.save();
    try {
      await sendVerificationEmail(user, verificationToken);
    } catch (error) {
      // L'utilisateur peut redemander un email de vérification via un autre endpoint
      // si l'envoi échoue ici (SMTP down, rate limit, etc.).
      logger.error('Échec de l\'envoi de l\'email de vérification', {
        error: error instanceof Error ? error.message : String(error),
        userId
      });
    }
    emailUpdated = true;
  }

  if (phoneNumber !== undefined) {
    if (phoneNumber === '') {
      user.phoneNumber = undefined;
      user.isPhoneVerified = false;
      phoneNumberUpdated = true;
    } else {
      if (!validatePhoneNumber(phoneNumber)) {
        throw new HttpError(400, 'Format de numéro de téléphone invalide');
      }

      if (user.phoneNumber !== phoneNumber) {
        user.phoneNumber = phoneNumber;
        user.isPhoneVerified = false;
        phoneNumberUpdated = true;
      }
    }
  }

  if (paypalEmail !== undefined && paypalEmail !== user.paypalEmail) {
    if (paypalEmail === '' || paypalEmail === null) {
      user.paypalEmail = undefined;
    } else {
      if (!validateEmail(paypalEmail)) {
        throw new HttpError(400, 'Format d\'email PayPal invalide');
      }
      if (paypalEmail.toLowerCase() === user.email.toLowerCase()) {
        throw new HttpError(400, 'L\'email PayPal ne peut pas être identique à votre email principal');
      }
      const existing = await User.findOne({ paypalEmail, _id: { $ne: userId } });
      if (existing) {
        throw new HttpError(400, 'Cet email PayPal est déjà utilisé par un autre utilisateur');
      }
      user.paypalEmail = paypalEmail;
    }
    user.markModified('paypalEmail');
  }

  if (bio !== undefined) user.bio = bio.substring(0, 500);
  if (location !== undefined) user.location = location.substring(0, 100);
  if (socialLinks) user.socialLinks = { ...user.socialLinks, ...socialLinks };
  if (preferences) user.preferences = { ...user.preferences, ...preferences };

  await user.save();

  let message = 'Profil mis à jour avec succès';
  if (emailUpdated && phoneNumberUpdated) {
    message = 'Profil mis à jour. Veuillez vérifier votre nouvelle adresse email et votre numéro de téléphone.';
  } else if (emailUpdated) {
    message = 'Profil mis à jour. Veuillez vérifier votre nouvelle adresse email.';
  } else if (phoneNumberUpdated) {
    message = 'Profil mis à jour. Veuillez vérifier votre nouveau numéro de téléphone.';
  }

  return {
    message,
    user: {
      id: user._id,
      username: user.username,
      email: user.email,
      paypalEmail: user.paypalEmail,
      phoneNumber: user.phoneNumber,
      isPhoneVerified: user.isPhoneVerified,
      bio: user.bio,
      location: user.location,
      socialLinks: user.socialLinks,
      preferences: user.preferences,
      isEmailVerified: user.isEmailVerified
    }
  };
}

/**
 * Première complétion de profil pour un compte créé via OAuth.
 * Délègue les validations à `updateProfileData`, puis flippe `profileCompleted`
 * à `true` à condition qu'un numéro de téléphone ait été renseigné.
 */
export async function completeFirstProfile(userId: string, body: any) {
  const result = await updateProfileData(userId, body);
  const user = await loadUserOr404(userId);

  if (!user.phoneNumber) {
    throw new HttpError(400, 'Le numéro de téléphone est requis pour compléter le profil');
  }

  user.profileCompleted = true;
  if (body?.privacyPolicyAccepted) {
    user.privacyPolicyAccepted = true;
    user.privacyPolicyAcceptedAt = new Date();
  }
  if (body?.dataProcessingConsent) {
    user.dataProcessingConsent = true;
    user.dataProcessingConsentAt = new Date();
  }
  if (body?.marketingConsent !== undefined) {
    user.marketingConsent = !!body.marketingConsent;
    user.marketingConsentAt = new Date();
  }
  await user.save();

  return { ...result, profileCompleted: true };
}

export async function softDeleteAccount(userId: string, password?: string) {
  // Mongoose crée des sous-documents vides par défaut — on vérifie l'id explicitement
  // pour savoir si un provider social est vraiment rattaché.
  const userWithPassword = await User.findById(userId).select('+password');
  if (!userWithPassword) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  const hasSocialAuth = Boolean(
    userWithPassword.socialAuth?.google?.id ||
    userWithPassword.socialAuth?.facebook?.id ||
    userWithPassword.socialAuth?.discord?.id
  );

  if (!hasSocialAuth) {
    if (!password) {
      throw new HttpError(400, 'Mot de passe requis pour confirmer la suppression');
    }

    const isPasswordValid = await userWithPassword.comparePassword(password);
    if (!isPasswordValid) {
      throw new HttpError(401, 'Mot de passe incorrect');
    }
  }

  const user = userWithPassword;

  user.accountStatus = 'deleted';
  user.email = `deleted_${user._id}_${user.email}`;
  user.username = `deleted_${user._id}_${user.username}`;
  await user.save();

  // Envoyer un email de confirmation
  // await sendAccountDeletionEmail(user);

  // Invalider tous les refresh tokens de l'utilisateur
  // await invalidateAllUserRefreshTokens(userId);
}

export async function setPayPalEmail(userId: string, paypalEmail: string, confirmPassword?: string) {
  if (!paypalEmail) {
    throw new HttpError(400, 'Email PayPal requis');
  }

  if (!validateEmail(paypalEmail)) {
    throw new HttpError(400, 'Format d\'email PayPal invalide');
  }

  const user = await loadUserOr404(userId);

  if (paypalEmail.toLowerCase() === user.email.toLowerCase()) {
    throw new HttpError(400, 'L\'email PayPal ne peut pas être identique à votre email principal');
  }

  const existingUsers = await User.find({
    $and: [
      { _id: { $ne: userId } },
      { paypalEmail: paypalEmail }
    ]
  });

  if (existingUsers.length > 0) {
    throw new HttpError(400, 'Cet email PayPal est déjà utilisé par un autre utilisateur');
  }

  await verifyPasswordIfProvided(userId, confirmPassword);

  user.paypalEmail = paypalEmail;
  user.markModified('paypalEmail');
  await user.save();

  logger.info('Email PayPal mis à jour', {
    userId,
    newPayPalEmail: paypalEmail
  });

  return user.paypalEmail;
}

export async function clearPayPalEmail(userId: string, confirmPassword?: string) {
  const user = await loadUserOr404(userId);

  if (!user.paypalEmail) {
    throw new HttpError(400, 'Aucun email PayPal n\'est configuré sur ce compte');
  }

  await verifyPasswordIfProvided(userId, confirmPassword);

  user.paypalEmail = undefined;
  user.markModified('paypalEmail');
  await user.save();

  logger.info('Email PayPal supprimé', { userId });
}
