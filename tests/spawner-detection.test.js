const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { countSpawnersInItems, countSpawnersInShulker, isSkeletonSpawner } =
  require(path.join(__dirname, '../src/systems/spawnerSell.js'));

const VERSION = '1.21.1';
const reg = require('minecraft-data')(VERSION);
const bot = { version: VERSION };

const SPAWNER_ID = reg.itemsByName.spawner.id;
const DIAMOND_ID = reg.itemsByName.diamond.id;

// A shulker slot entry in the 1.20.5+ network format, with a custom_name chat component.
function slot(itemId, itemCount, name) {
  const components = name
    ? [{ type: 'custom_name', data: { extra: [{ text: name }], text: '' } }]
    : [];
  return { itemId, itemCount, components };
}

function shulkerWith(contents) {
  return {
    name: 'red_shulker_box',
    count: 1,
    components: [{ type: 'minecraft:container', data: { contents } }],
  };
}

test('counts skeleton spawners inside a shulker box (numeric itemId + custom_name)', () => {
  const shulker = shulkerWith([
    slot(SPAWNER_ID, 2, 'Skeleton Spawner'),
    slot(SPAWNER_ID, 3, '§bSkeleton Spawner'),
  ]);
  assert.equal(countSpawnersInShulker(shulker.components, bot), 5);
  assert.equal(countSpawnersInItems([shulker], bot), 5);
});

test('ignores non-skeleton spawners and non-spawner items in a shulker', () => {
  const shulker = shulkerWith([
    slot(SPAWNER_ID, 4, 'Zombie Spawner'),
    slot(SPAWNER_ID, 1, 'Skeleton Spawner'),
    slot(DIAMOND_ID, 64, 'Diamond'),
  ]);
  assert.equal(countSpawnersInShulker(shulker.components, bot), 1);
});

test('counts a directly-held skeleton spawner stack', () => {
  const item = {
    name: 'spawner',
    count: 7,
    components: [{ type: 'custom_name', data: { extra: [{ text: 'Skeleton Spawner' }], text: '' } }],
  };
  assert.equal(isSkeletonSpawner(item), true);
  assert.equal(countSpawnersInItems([item], bot), 7);
});

test('a plain unnamed spawner is not treated as a skeleton spawner', () => {
  const item = { name: 'spawner', count: 1, components: [] };
  assert.equal(isSkeletonSpawner(item), false);
  assert.equal(countSpawnersInItems([item], bot), 0);
});

test('returns 0 for a shulker with no container component', () => {
  const shulker = { name: 'red_shulker_box', count: 1, components: [] };
  assert.equal(countSpawnersInShulker(shulker.components, bot), 0);
});
