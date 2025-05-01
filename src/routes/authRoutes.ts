import { Router } from 'express';
import passport from 'passport';
import { register, login, logout, verifyToken, generateToken } from '../controllers/authController';

const router = Router();

// Routes d'authentification standard
router.post('/register', register);
router.post('/login', login);
router.post('/logout', logout);

// Routes d'authentification Discord
router.get('/discord', passport.authenticate('discord'));
router.get('/discord/callback', 
  passport.authenticate('discord', { session: false, failureRedirect: '/login' }),
  generateToken
);

// Routes d'authentification Google
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
router.get('/google/callback', 
  passport.authenticate('google', { session: false, failureRedirect: '/login' }),
  generateToken
);

// Routes d'authentification Facebook
router.get('/facebook', passport.authenticate('facebook', { scope: ['email'] }));
router.get('/facebook/callback', 
  passport.authenticate('facebook', { session: false, failureRedirect: '/login' }),
  generateToken
);

// Route protégée d'exemple
router.get('/protected', passport.authenticate('jwt', { session: false }), (req, res) => {
  res.json({ message: 'Ceci est une route protégée', user: req.user });
});

export default router;