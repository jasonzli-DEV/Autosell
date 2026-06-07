const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('GitHub Actions CI runs install and test on pushes and pull requests', () => {
  const workflowPath = path.join(__dirname, '../.github/workflows/ci.yml');
  assert.equal(fs.existsSync(workflowPath), true);

  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /on:\s*\n\s+push:/);
  assert.match(workflow, /\n\s+pull_request:/);
  assert.match(workflow, /node-version:\s*20/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm test/);
});
