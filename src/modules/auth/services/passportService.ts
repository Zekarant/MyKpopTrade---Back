import User, { IUser } from '../../../models/userModel';

/**
 * Trouve ou crée un utilisateur à partir des données d'authentification sociale
 * Cette fonction est utilisée par les stratégies Google, Facebook et Discord
 */
export const findOrCreateSocialUser = async (
  providerId: string,
  email: string,
  provider: 'google' | 'facebook' | 'discord',
  displayName: string,
  additionalData: Record<string, any> = {}
): Promise<IUser> => {
  try {
    // Vérifier si un utilisateur avec cet email existe déjà
    let user = await User.findOne({ email });

    if (user) {
      // Mettre à jour les informations sociales si nécessaire
      if (!user.socialAuth?.[provider]?.id) {
        user.socialAuth = user.socialAuth || {};
        user.socialAuth[provider] = {
          id: providerId,
          email: email,
          ...additionalData
        };
        user.isEmailVerified = true;
        await user.save({ validateBeforeSave: false });
      }
    } else {
      // Créer un nouvel utilisateur
      const username = `${provider}_${Date.now()}`;

      user = new User({
        username,
        email,
        password: Math.random().toString(36).substring(2),
        isEmailVerified: true,
        // Flag à `false` pour les comptes OAuth fraîchement créés : ils n'ont pas
        // pu remplir téléphone / RGPD à l'inscription, le front les redirigera
        // vers la page de complétion de profil.
        profileCompleted: false,
        socialAuth: {
          [provider]: {
            id: providerId,
            email,
            ...additionalData
          }
        }
      });

      await user.save({ validateBeforeSave: false });
    }
    
    // Mettre à jour la date de dernière connexion
    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });
    
    return user;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Une erreur inconnue est survenue';
    throw new Error(`Erreur lors de l'authentification sociale: ${errorMessage}`);
  }
};

/**
 * Nettoie les données de profil social pour créer un profil utilisateur cohérent
 */
export const formatSocialProfile = (profile: any, provider: 'google' | 'facebook' | 'discord') => {
  let email, name, picture;
  
  switch (provider) {
    case 'google':
      email = profile.emails?.[0]?.value;
      name = profile.displayName;
      picture = profile.photos?.[0]?.value;
      break;
      
    case 'facebook':
      email = profile.emails?.[0]?.value;
      name = profile.displayName;
      picture = profile.photos?.[0]?.value;
      break;
      
    case 'discord':
      email = profile.email;
      name = profile.username;
      picture = `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`;
      break;
  }
  
  return { email, name, picture };
};