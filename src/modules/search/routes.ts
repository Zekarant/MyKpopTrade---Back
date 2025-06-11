import { Router } from 'express';
import * as searchController from './controllers/searchController';
import { authenticateJWT } from '../../commons/middlewares/authMiddleware';

const router = Router();

// Recherche publique
router.post('/advanced', searchController.advancedSearch);
router.get('/suggestions', searchController.getSearchSuggestions);

// Historique de recherche (nécessite une authentification)
router.get('/history', authenticateJWT, searchController.getUserSearchHistory);
router.delete('/history/:historyId', authenticateJWT, searchController.deleteSearchHistoryItem);
router.delete('/history', authenticateJWT, searchController.clearSearchHistory);

export default router;