'use strict';

const { Router } = require('express');
const inputsRouter = require('./inputs');
const scenesRouter = require('./scenes');
const streamRouter = require('./stream');

const router = Router();

router.use('/inputs', inputsRouter);
router.use('/scenes', scenesRouter);

// Legacy /api/scene endpoints — re-dispatch into the scenes router's /legacy handlers
router.get('/scene', (req, res, next) => { req.url = '/legacy'; scenesRouter(req, res, next); });
router.post('/scene', (req, res, next) => { req.url = '/legacy'; scenesRouter(req, res, next); });
router.patch('/scene', (req, res, next) => { req.url = '/legacy'; scenesRouter(req, res, next); });

router.use('/', streamRouter);

module.exports = router;
