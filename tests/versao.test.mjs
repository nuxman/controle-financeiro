import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERSAO, DATA_VERSAO } from '../js/versao.js';

test('versao.json e js/versao.js estão iguais', () => {
  const j = JSON.parse(readFileSync(new URL('../versao.json', import.meta.url), 'utf8'));
  assert.equal(j.versao, VERSAO);
  assert.equal(j.data, DATA_VERSAO);
  assert.match(VERSAO, /^\d+\.\d+\.\d+$/);
});
