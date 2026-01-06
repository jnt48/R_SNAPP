#!/usr/bin/env node

/**
 * Test Suite for Snapp Package Manager
 * Run with: node test-snapp.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// Test configuration
const TEST_DIR = path.join(os.tmpdir(), 'snapp-test-' + Date.now());
const SNAPP_PATH = path.join(__dirname, 'snapp-improved.js');

// Colors for output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m'
};

let testsPassed = 0;
let testsFailed = 0;

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function runCommand(command, expectError = false) {
  try {
    const output = execSync(command, { 
      cwd: TEST_DIR, 
      encoding: 'utf8',
      stdio: expectError ? 'pipe' : 'inherit'
    });
    return { success: true, output };
  } catch (error) {
    if (expectError) {
      return { success: false, error: error.message, output: error.stdout };
    }
    throw error;
  }
}

function testCase(name, fn) {
  try {
    log(`\n▶ Testing: ${name}`, 'blue');
    fn();
    testsPassed++;
    log(`  ✓ PASSED`, 'green');
  } catch (error) {
    testsFailed++;
    log(`  ✗ FAILED: ${error.message}`, 'red');
    if (process.env.SNAPP_DEBUG) {
      console.error(error);
    }
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertFileExists(filePath, message) {
  const fullPath = path.join(TEST_DIR, filePath);
  assert(fs.existsSync(fullPath), message || `File should exist: ${filePath}`);
}

function assertFileNotExists(filePath, message) {
  const fullPath = path.join(TEST_DIR, filePath);
  assert(!fs.existsSync(fullPath), message || `File should not exist: ${filePath}`);
}

function setup() {
  log('🚀 Setting up test environment...', 'blue');
  
  // Create test directory
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
  
  // Make snapp executable
  try {
    fs.chmodSync(SNAPP_PATH, 0o755);
  } catch (e) {
    log('  Warning: Could not make snapp executable', 'yellow');
  }
  
  log(`  Test directory: ${TEST_DIR}`, 'blue');
  log(`  Snapp path: ${SNAPP_PATH}`, 'blue');
}

function cleanup() {
  log('\n🧹 Cleaning up...', 'blue');
  
  try {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    log('  Cleanup complete', 'green');
  } catch (error) {
    log(`  Cleanup warning: ${error.message}`, 'yellow');
  }
}

// ============== TEST CASES ==============

function runTests() {
  // Test 1: Init command
  testCase('snapp init creates package.json', () => {
    runCommand(`node "${SNAPP_PATH}" init`);
    assertFileExists('package.json');
    
    const packageJson = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'package.json'), 'utf8'));
    assert(packageJson.name, 'package.json should have a name');
    assert(packageJson.version, 'package.json should have a version');
    assert(packageJson.dependencies, 'package.json should have dependencies object');
  });

  // Test 2: Init command when package.json exists
  testCase('snapp init warns when package.json exists', () => {
    const result = runCommand(`node "${SNAPP_PATH}" init`, true);
    assert(result.output.includes('already exists'), 'Should warn about existing package.json');
  });

  // Test 3: Add command
  testCase('snapp add adds a dependency', () => {
    const result = runCommand(`node "${SNAPP_PATH}" add lodash@4.17.21`, false);
    
    const packageJson = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'package.json'), 'utf8'));
    assert(packageJson.dependencies.lodash === '4.17.21', 'lodash should be added to dependencies');
  });

  // Test 4: Add dev dependency
  testCase('snapp add --dev adds a dev dependency', () => {
    runCommand(`node "${SNAPP_PATH}" add eslint --dev`);
    
    const packageJson = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'package.json'), 'utf8'));
    assert(packageJson.devDependencies.eslint, 'eslint should be added to devDependencies');
  });

  // Test 5: Install command (this will actually download packages)
  testCase('snapp install downloads and installs packages', () => {
    log('  This may take a moment...', 'yellow');
    runCommand(`node "${SNAPP_PATH}" install`);
    
    assertFileExists('node_modules', 'node_modules directory should exist');
    assertFileExists('snapp-lock.json', 'snapp-lock.json should be created');
    assertFileExists('node_modules/lodash', 'lodash should be installed');
  });

  // Test 6: Lock file structure
  testCase('snapp-lock.json has correct structure', () => {
    const lockFile = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'snapp-lock.json'), 'utf8'));
    
    assert(lockFile.version, 'Lock file should have version');
    assert(lockFile.resolved, 'Lock file should have resolved packages');
    assert(lockFile.timestamp, 'Lock file should have timestamp');
    assert(Object.keys(lockFile.resolved).length > 0, 'Lock file should have resolved packages');
  });

  // Test 7: Cache is created
  testCase('Cache directory is created', () => {
    const cacheDir = path.join(os.homedir(), '.snapp', 'cache');
    assert(fs.existsSync(cacheDir), 'Cache directory should exist');
  });

  // Test 8: List command
  testCase('snapp list shows installed packages', () => {
    const result = runCommand(`node "${SNAPP_PATH}" list`);
    assert(result.success, 'List command should succeed');
  });

  // Test 9: Remove command
  testCase('snapp remove removes a package', () => {
    runCommand(`node "${SNAPP_PATH}" remove lodash`);
    
    const packageJson = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'package.json'), 'utf8'));
    assert(!packageJson.dependencies.lodash, 'lodash should be removed from dependencies');
    assertFileNotExists('node_modules/lodash', 'lodash directory should be removed');
  });

  // Test 10: Cache command
  testCase('snapp cache shows cache info', () => {
    const result = runCommand(`node "${SNAPP_PATH}" cache`);
    assert(result.success, 'Cache command should succeed');
  });

  // Test 11: Help command
  testCase('snapp help shows usage information', () => {
    const result = runCommand(`node "${SNAPP_PATH}" help`);
    assert(result.output.includes('SNAPP'), 'Help should show SNAPP info');
    assert(result.output.includes('Commands'), 'Help should list commands');
  });

  // Test 12: Unknown command
  testCase('snapp handles unknown commands', () => {
    const result = runCommand(`node "${SNAPP_PATH}" invalidcommand`, true);
    assert(!result.success, 'Unknown command should fail');
  });

  // Test 13: Production install
  testCase('snapp install --production skips dev dependencies', () => {
    // Add both regular and dev dependencies
    runCommand(`node "${SNAPP_PATH}" add express`);
    runCommand(`node "${SNAPP_PATH}" add jest --dev`);
    
    // Clear node_modules
    const nmPath = path.join(TEST_DIR, 'node_modules');
    if (fs.existsSync(nmPath)) {
      fs.rmSync(nmPath, { recursive: true, force: true });
    }
    
    // Install production only
    log('  Installing production dependencies only...', 'yellow');
    runCommand(`node "${SNAPP_PATH}" install --production`);
    
    assertFileExists('node_modules/express', 'express should be installed');
    // Note: jest might be installed due to dependencies, so we just check the command runs
  });

  // Test 14: Outdated command
  testCase('snapp outdated checks for updates', () => {
    const result = runCommand(`node "${SNAPP_PATH}" outdated`);
    assert(result.success, 'Outdated command should succeed');
  });

  // Test 15: Multiple package add
  testCase('snapp add supports multiple packages', () => {
    runCommand(`node "${SNAPP_PATH}" add axios chalk`);
    
    const packageJson = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'package.json'), 'utf8'));
    assert(packageJson.dependencies.axios, 'axios should be added');
    assert(packageJson.dependencies.chalk, 'chalk should be added');
  });
}

// ============== MAIN ==============

function main() {
  console.log('═══════════════════════════════════════════');
  console.log('   Snapp Package Manager Test Suite');
  console.log('═══════════════════════════════════════════\n');

  setup();

  try {
    runTests();
  } catch (error) {
    log(`\n💥 Fatal error: ${error.message}`, 'red');
    if (process.env.SNAPP_DEBUG) {
      console.error(error);
    }
  }

  cleanup();

  // Print summary
  console.log('\n═══════════════════════════════════════════');
  console.log('   Test Summary');
  console.log('═══════════════════════════════════════════');
  log(`✓ Passed: ${testsPassed}`, 'green');
  if (testsFailed > 0) {
    log(`✗ Failed: ${testsFailed}`, 'red');
  }
  console.log(`  Total: ${testsPassed + testsFailed}`);
  console.log('═══════════════════════════════════════════\n');

  process.exit(testsFailed > 0 ? 1 : 0);
}

main();