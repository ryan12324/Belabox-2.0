'use strict';

const { Router } = require('express');
const state = require('../state');
const { broadcast } = require('../ws');

const router = Router();

router.get('/', (_req, res) => res.json(state.inputs));

router.post('/', (req, res) => {
  const input = req.body;
  if (!input || !input.id || !input.type) return res.status(400).json({ error: 'Invalid input' });
  state.inputs = state.inputs.filter(i => i.id !== input.id);
  state.inputs.push(input);
  broadcast({ type: 'inputs_updated', inputs: state.inputs });
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  state.inputs = state.inputs.filter(i => i.id !== req.params.id);
  broadcast({ type: 'inputs_updated', inputs: state.inputs });
  res.json({ ok: true });
});

module.exports = router;
