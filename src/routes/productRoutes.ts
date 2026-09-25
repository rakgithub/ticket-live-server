import { Router } from 'express';

const routes = Router();

const products = [{
    id: '1',
    name: 'prod1'
}];

routes.get('/', (req,res) => {
    res.json(products);
});

routes.get('/:id', (req,res) => {
    res.json({
    id: req.params.id,
  });
});

routes.get('/api', (req,res) => {
    res.json(products);
});

routes.post('/', (req,res) => {
    res.json('Done').status(201);
});

export default routes;