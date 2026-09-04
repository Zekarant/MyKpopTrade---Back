import express from 'express';
import { authenticateJWT, requireAdmin } from '../../commons/middlewares/authMiddleware';
import { searchUsers } from './controllers/userSearchController';
import * as userPrivacyController from './controllers/userPrivacyController';
import * as userAdminController from './controllers/userAdminController';
import * as adminModerationController from './controllers/adminModerationController';

const router = express.Router();

// Routes publiques

// Recherche utilisateur partielle
router.get('/search', searchUsers);

// Routes protégées
router.put('/me/consents', authenticateJWT, userPrivacyController.updateUserConsents);
router.get('/me/data-export', authenticateJWT, userPrivacyController.exportUserData);
router.post('/me/deletion-request', authenticateJWT, userPrivacyController.requestAccountDeletion);
router.delete('/me/deletion-request', authenticateJWT, userPrivacyController.cancelDeletionRequest);
router.post('/me/anonymize', authenticateJWT, userPrivacyController.anonymizeUserData);

// Routes admin
router.get('/admin/list', authenticateJWT, requireAdmin, userAdminController.getUsers);
router.get('/admin/stats', authenticateJWT, requireAdmin, userAdminController.getAdminStats);
router.get('/admin/stats/timeseries', authenticateJWT, requireAdmin, userAdminController.getStatsTimeseries);
router.get('/admin/queue', authenticateJWT, requireAdmin, userAdminController.getAdminQueue);
router.get('/admin/search', authenticateJWT, requireAdmin, userAdminController.adminGlobalSearch);
router.get('/admin/deletion-requests', authenticateJWT, requireAdmin, userAdminController.getDeletionRequests);
router.get('/admin/rgpd-stats', authenticateJWT, requireAdmin, userAdminController.getRgpdStats);
router.get('/admin/export-data', authenticateJWT, requireAdmin, userAdminController.adminExportUserData);
router.post('/admin/anonymize', authenticateJWT, requireAdmin, userAdminController.adminAnonymizeUser);

// Admin modération posts
router.get('/admin/posts', authenticateJWT, requireAdmin, adminModerationController.getAdminPosts);
router.get('/admin/posts/stats', authenticateJWT, requireAdmin, adminModerationController.getPostStats);
router.delete('/admin/posts/:postId', authenticateJWT, requireAdmin, adminModerationController.adminDeletePost);

// Admin audit
router.get('/admin/audit', authenticateJWT, requireAdmin, adminModerationController.getAuditLogs);
router.get('/admin/audit/stats', authenticateJWT, requireAdmin, adminModerationController.getAuditStats);

router.get('/admin/:userId/detail', authenticateJWT, requireAdmin, userAdminController.getUserDetail);
router.post('/admin/:userId/notes', authenticateJWT, requireAdmin, userAdminController.addUserNote);
router.delete('/admin/:userId/notes/:noteId', authenticateJWT, requireAdmin, userAdminController.deleteUserNote);

router.post('/admin/:userId/confirm-deletion', authenticateJWT, requireAdmin, userAdminController.confirmDeletion);
router.post('/admin/:userId/cancel-deletion', authenticateJWT, requireAdmin, userAdminController.adminCancelDeletion);
router.put('/admin/:userId/status', authenticateJWT, requireAdmin, userAdminController.updateUserStatus);
router.put('/admin/:userId/role', authenticateJWT, requireAdmin, userAdminController.updateUserRole);

export default router;