import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayorDeVersion, nombreConVersion, siguienteVersion } from '../src/lib/versiones.js';
import { fechaDeDia, textoLimpio } from '../src/lib/format.js';

test('siguienteVersion: sube el número mayor por encima del más alto que haya existido', () => {
  assert.equal(siguienteVersion([]), 'v1.0');
  assert.equal(siguienteVersion(['v1.0']), 'v2.0');
  assert.equal(siguienteVersion(['v3.2', 'v3.1', 'v3.0']), 'v4.0'); // datos heredados con menores
  assert.equal(siguienteVersion(['v1.0', 'v3.0', 'v2.0']), 'v4.0'); // restaurada la v1.0: nunca se reutiliza v2/v3
  assert.equal(siguienteVersion(['V2', 'raro', null]), 'v3.0');
});

test('mayorDeVersion y nombreConVersion', () => {
  assert.equal(mayorDeVersion('v12.4'), 12);
  assert.equal(mayorDeVersion('final'), null);
  assert.equal(nombreConVersion('Contrato.pdf', 'v1.0'), 'Contrato (v1.0).pdf');
  assert.equal(nombreConVersion('Acta', 'v2.0'), 'Acta (v2.0).pdf');
});

test('fechaDeDia no corre la fecha al día anterior (columna date sin hora)', () => {
  assert.equal(fechaDeDia('2034-03-01'), '01 Mar 2034');
  assert.equal(fechaDeDia(null), '');
  assert.equal(textoLimpio('  a\u0007  b ', 10), 'a b');
});
