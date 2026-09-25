import { Router } from 'express';
import { register  } from '../controller/registerController.ts';
import { login } from '../controller/loginController.ts';

const authRoutes = Router();

authRoutes.post('/register', register);
authRoutes.post('/login', login);

export default authRoutes;