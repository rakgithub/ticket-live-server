import express from 'express';
import "dotenv/config";
import productRoutes from './routes/productRoutes.ts';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { drizzle } from 'drizzle-orm/node-postgres';
import authRoutes from './routes/authRoutes.ts';

const app = express();
const db = drizzle(process.env.DATABASE_URL!);

// MIDDLEWARE 
app.use(helmet());
app.use(cors());
app.use(morgan('dev')); // LOGGING
app.use(express.json()) // ENABLE JSON BODY PARSING

// ROUTES
app.use('/products', productRoutes);
app.use('/', authRoutes);

const port = process.env.PORT ?? 4002;

app.listen(port, () => console.log('Listening to port ' + port));