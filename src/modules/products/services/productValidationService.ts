import Joi from 'joi';

/**
 * Schéma de validation pour la création et mise à jour de produits
 */
export const productSchema = Joi.object({
  title: Joi.string().min(3).max(100).required()
    .messages({
      'string.min': 'Le titre doit contenir au moins 3 caractères',
      'string.max': 'Le titre ne peut pas dépasser 100 caractères',
      'any.required': 'Le titre est obligatoire'
    }),
  
  description: Joi.string().min(10).max(1000).required()
    .messages({
      'string.min': 'La description doit contenir au moins 10 caractères',
      'string.max': 'La description ne peut pas dépasser 1000 caractères',
      'any.required': 'La description est obligatoire'
    }),
  
  price: Joi.number().min(0).required()
    .messages({
      'number.base': 'Le prix doit être un nombre',
      'number.min': 'Le prix ne peut pas être négatif',
      'any.required': 'Le prix est obligatoire'
    }),
  
  currency: Joi.string().valid('EUR', 'USD', 'KRW', 'JPY', 'GBP').default('EUR')
    .messages({
      'any.only': 'Devise non supportée'
    }),
  
  condition: Joi.string().valid('new', 'likeNew', 'good', 'fair', 'poor').required()
    .messages({
      'any.only': 'Condition invalide',
      'any.required': 'La condition est obligatoire'
    }),
  
  category: Joi.string().required()
    .messages({
      'any.required': 'La catégorie est obligatoire'
    }),
  
  type: Joi.string().valid('photocard', 'album', 'merch', 'other').required()
    .messages({
      'any.only': 'Type invalide',
      'any.required': 'Le type est obligatoire'
    }),
  
  kpopGroup: Joi.string().required()
    .messages({
      'any.required': 'Le groupe K-pop est obligatoire'
    }),
  
  kpopMember: Joi.string().allow('', null),
  
  albumName: Joi.string().allow('', null),
  
  images: Joi.array().items(Joi.string()).min(1).max(10).required()
  .messages({
    'array.min': 'Au moins une image est requise',
    'array.max': 'Maximum 10 images autorisées',
    'any.required': 'Les images sont obligatoires'
  }),
  
  shippingOptions: Joi.object({
    worldwide: Joi.boolean().default(false),
    nationalOnly: Joi.boolean().default(true),
    localPickup: Joi.boolean().default(false),
    shippingCost: Joi.number().min(0)
  }).default({
    worldwide: false,
    nationalOnly: true,
    localPickup: false
  })
});

/**
 * Valide les données d'un produit
 */
export const validateProductData = (data: any) => {
  return productSchema.validate(data, { abortEarly: false });
};