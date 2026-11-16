import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { normaliseAgents, pickAgent, agentLine, teamsOf, talkMs, frameFor, TALK_MIN_MS, TALK_MAX_MS } from '../src/guide/companion.js';

const file = new URL('../public/companions/agents.json', import.meta.url);

test('companions: agents.json lists the eight helpers, and every file it names is in public/companions', () => {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const agents = normaliseAgents(raw, '');
  assert.equal(agents.length, 8);
  assert.deepEqual(
    agents.map((a) => a.name),
    ['João Paulo', 'Halytza', 'George', 'Yassin', 'Janisha', 'Erina', 'Chyu', 'João Victor'],
  );
  for (const a of agents)
    for (const key of ['portrait', 'speaking', 'idle', 'talking'])
      assert.ok(existsSync(new URL(`../public/companions/${a[key]}`, import.meta.url)), `${a.id} ${key}: ${a[key]}`);
});

test('companions: missing fields get the standard file names; bad and repeated ids are dropped', () => {
  const list = normaliseAgents([{ id: 'agent-1', name: '  ' }, { id: 'agent-1' }, { id: '../x' }, null, { id: 'agent-2', team: 'Data', role: 'Lead' }], '/c/');
  assert.deepEqual(list.map((a) => a.id), ['agent-1', 'agent-2']);
  assert.equal(list[0].name, 'agent-1');
  assert.equal(list[0].idle, '/c/agent-1/idle.webp');
  assert.equal(list[0].talking, '/c/agent-1/talking.webp');
  assert.equal(agentLine(list[1]), 'Lead · Data');
  assert.equal(agentLine(list[0]), '');
  assert.deepEqual(teamsOf(list), ['Data']);
});

test('companions: the stored choice is kept while it exists, else the first helper', () => {
  const list = normaliseAgents([{ id: 'a' }, { id: 'b' }], '');
  assert.equal(pickAgent(list, 'b').id, 'b');
  assert.equal(pickAgent(list, 'gone').id, 'a');
  assert.equal(pickAgent(list, null).id, 'a');
  assert.equal(pickAgent([], 'a'), null);
});

test('companions: talking lasts about the words, within limits; reduced motion shows still poses', () => {
  assert.equal(talkMs(''), 0);
  assert.equal(talkMs('Hi'), TALK_MIN_MS);
  assert.equal(talkMs('word '.repeat(200)), TALK_MAX_MS);
  const [a] = normaliseAgents([{ id: 'a' }], '');
  assert.equal(frameFor(a), 'a/idle.webp');
  assert.equal(frameFor(a, { talking: true }), 'a/talking.webp');
  assert.equal(frameFor(a, { reduced: true }), 'a/portrait.png');
  assert.equal(frameFor(a, { talking: true, reduced: true }), 'a/speaking.png');
});
