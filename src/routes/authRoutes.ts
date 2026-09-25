import { Router } from 'express';
import { loginRateLimit } from '../auth/loginRateLimit.ts';
import { register } from '../controllers/auth/registerController.ts';
import { login } from '../controllers/auth/loginController.ts';
import { logout } from '../controllers/auth/logoutController.ts';
import { requireAuth } from '../auth/requireAuth.ts';

const authRoutes = Router();

authRoutes.post('/register', register);
authRoutes.post('/login', loginRateLimit, login);
authRoutes.post('/logout', requireAuth, logout);

export default authRoutes;
