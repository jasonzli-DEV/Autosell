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

// Component builders. lore/block_entity_data are plugin/server set and NOT editable
// with an anvil; custom_name IS the player-editable display name.
const lore = (text) => ({ type: 'lore', data: [{ extra: [{ text }], text: '' }] });
const customName = (text) => ({ type: 'custom_name', data: { extra: [{ text }], text: '' } });
const blockEntity = (mobId) => ({ type: 'block_entity_data', data: { SpawnData: { entity: { id: mobId } } } });

function slot(itemId, itemCount, components = []) {
  return { itemId, itemCount, components };
}

function shulkerWith(contents) {
  return {
    name: 'red_shulker_box',
    count: 1,
    components: [{ type: 'minecraft:container', data: { contents } }],
  };
}

test('counts skeleton spawners in a shulker using the trusted lore', () => {
  const shulker = shulkerWith([
    slot(SPAWNER_ID, 2, [lore('Skeleton'), customName('Skeleton Spawner')]),
    slot(SPAWNER_ID, 3, [lore('§7Skeleton Spawner')]),
  ]);
  assert.equal(countSpawnersInShulker(shulker.components, bot), 5);
  assert.equal(countSpawnersInItems([shulker], bot), 5);
});

test('counts skeleton spawners identified by block_entity_data', () => {
  const item = { name: 'spawner', count: 4, components: [blockEntity('minecraft:skeleton')] };
  assert.equal(isSkeletonSpawner(item), true);
  assert.equal(countSpawnersInItems([item], bot), 4);
});

// Anti-fraud: renaming a non-skeleton spawner must not fool the bot.
test('a renamed (custom_name) non-skeleton spawner is NOT counted', () => {
  const tricked = { name: 'spawner', count: 10, components: [lore('Zombie'), customName('Skeleton Spawner')] };
  assert.equal(isSkeletonSpawner(tricked), false, 'must ignore the renameable display name');
  assert.equal(countSpawnersInItems([tricked], bot), 0);

  const shulker = shulkerWith([slot(SPAWNER_ID, 64, [lore('Pig'), customName('§bSkeleton Spawner')])]);
  assert.equal(countSpawnersInShulker(shulker.components, bot), 0);
});

test('a spawner with skeleton ONLY in custom_name (no trusted source) is NOT counted', () => {
  const tricked = { name: 'spawner', count: 5, components: [customName('Skeleton Spawner')] };
  assert.equal(isSkeletonSpawner(tricked), false);
  assert.equal(countSpawnersInItems([tricked], bot), 0);
});

test('ignores non-skeleton spawners and non-spawner items in a shulker', () => {
  const shulker = shulkerWith([
    slot(SPAWNER_ID, 4, [lore('Zombie')]),
    slot(SPAWNER_ID, 1, [lore('Skeleton')]),
    slot(DIAMOND_ID, 64, [lore('Skeleton')]), // a diamond, even loored "Skeleton", is not a spawner
  ]);
  assert.equal(countSpawnersInShulker(shulker.components, bot), 1);
});

test('a plain unnamed spawner is not treated as a skeleton spawner', () => {
  const item = { name: 'spawner', count: 1, components: [] };
  assert.equal(isSkeletonSpawner(item), false);
});
