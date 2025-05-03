import { IUser } from '../../../models/userModel';

/**
 * Calcule le pourcentage de complétion du profil
 * @param user Objet utilisateur
 * @returns Pourcentage de complétion (0-100)
 */
export const calculateProfileCompleteness = (user: IUser): number => {
  // Définir les champs qui contribuent à la complétion du profil
  const fields = [
    { name: 'profilePicture', weight: 15 },
    { name: 'bio', weight: 15 },
    { name: 'location', weight: 10 },
    { name: 'preferences.kpopGroups', weight: 10, isArray: true },
    { name: 'socialLinks.instagram', weight: 5 },
    { name: 'socialLinks.twitter', weight: 5 },
    { name: 'socialLinks.discord', weight: 5 },
    { name: 'isEmailVerified', weight: 20, isBoolean: true },
    { name: 'isPhoneVerified', weight: 15, isBoolean: true }
  ];
  
  let completeness = 0;
  
  fields.forEach(field => {
    // Accès aux propriétés imbriquées
    const path = field.name.split('.');
    let value = user;
    
    for (const key of path) {
      value = value?.[key as keyof typeof value];
      if (value === undefined) break;
    }
    
    // Évaluer si le champ contribue à la complétion
    if (field.isArray) {
      // Vérifier si c'est un tableau non vide
      if (Array.isArray(value) && value.length > 0) {
        completeness += field.weight;
      }
    } else if (field.isBoolean) {
      // Vérifier si la valeur est true
      if ((value as unknown) === true) {
        completeness += field.weight;
      }
    } else {
      // Vérifier si la valeur existe et n'est pas vide
      if (value !== undefined && value !== null && String(value) !== '') {
        completeness += field.weight;
      }
    }
  });
  
  return completeness;
};