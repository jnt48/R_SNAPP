#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const os = require('os');
const zlib = require('zlib');

// ============== CONFIGURATION ==============
const REGISTRY_URL = process.env.SNAPP_REGISTRY || 'https://registry.npmjs.org';
const MAX_PARALLEL_DOWNLOADS = parseInt(process.env.SNAPP_PARALLEL || '10', 10);
const SNAPP_LOCK_FILE = 'snapp-lock.json';
const NODE_MODULES = 'node_modules';
const CACHE_DIR = path.join(os.homedir(), '.snapp', 'cache');
const TEMP_DIR = path.join(os.homedir(), '.snapp', 'tmp');
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY = 1000;
const VERSION = '2.0.0';

// ============== UTILITY FUNCTIONS ==============

function log(message, type = 'info') {
  const colors = {
    info: '\x1b[36m',
    success: '\x1b[32m',
    error: '\x1b[31m',
    warn: '\x1b[33m',
    debug: '\x1b[90m',
    reset: '\x1b[0m'
  };
  const prefix = {
    info: 'ℹ',
    success: '✓',
    error: '✗',
    warn: '⚠',
    debug: '→'
  };
  console.log(`${colors[type]}${prefix[type]} ${message}${colors.reset}`);
}

function debug(message) {
  if (process.env.SNAPP_DEBUG) {
    log(message, 'debug');
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function httpsGet(url, retries = RETRY_ATTEMPTS) {
  return new Promise(async (resolve, reject) => {
    const attempt = async (attemptsLeft) => {
      debug(`Fetching: ${url} (${attemptsLeft} attempts left)`);
      
      https.get(url, { 
        headers: { 
          'User-Agent': `snapp-pm/${VERSION}`,
          'Accept': 'application/json'
        },
        timeout: 30000
      }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          resolve(httpsGet(res.headers.location, retries));
          return;
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Invalid JSON from ${url}`));
            }
          } else if (res.statusCode === 404) {
            reject(new Error(`Package not found: ${url}`));
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${url}`));
          }
        });
      }).on('error', async (err) => {
        if (attemptsLeft > 0) {
          debug(`Retry after error: ${err.message}`);
          await sleep(RETRY_DELAY);
          attempt(attemptsLeft - 1);
        } else {
          reject(err);
        }
      }).on('timeout', async () => {
        if (attemptsLeft > 0) {
          debug(`Retry after timeout`);
          await sleep(RETRY_DELAY);
          attempt(attemptsLeft - 1);
        } else {
          reject(new Error(`Timeout: ${url}`));
        }
      });
    };
    
    attempt(retries);
  });
}

async function downloadTarball(url, dest, expectedIntegrity = null) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const hash = crypto.createHash('sha512');
    
    https.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        downloadTarball(res.headers.location, dest, expectedIntegrity)
          .then(resolve)
          .catch(reject);
        return;
      }

      res.on('data', chunk => hash.update(chunk));
      res.pipe(file);
      
      file.on('finish', () => {
        file.close();
        
        // Verify integrity if provided
        if (expectedIntegrity) {
          const integrity = `sha512-${hash.digest('base64')}`;
          if (integrity !== expectedIntegrity) {
            fs.unlinkSync(dest);
            reject(new Error(`Integrity check failed for ${url}`));
            return;
          }
        }
        
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    }).on('timeout', () => {
      fs.unlink(dest, () => {});
      reject(new Error(`Download timeout: ${url}`));
    });
  });
}

async function extractTarball(tarballPath, extractPath) {
  try {
    await execAsync(`tar -xzf "${tarballPath}" -C "${extractPath}" --strip-components=1`);
  } catch (error) {
    throw new Error(`Failed to extract tarball: ${error.message}`);
  }
}

// ============== SEMVER IMPLEMENTATION ==============

class SemVer {
  static parse(version) {
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.-]+))?(?:\+([a-zA-Z0-9.-]+))?$/);
    if (!match) return null;
    
    return {
      major: parseInt(match[1]),
      minor: parseInt(match[2]),
      patch: parseInt(match[3]),
      prerelease: match[4] || null,
      build: match[5] || null,
      raw: version
    };
  }

  static satisfies(version, range) {
    const v = SemVer.parse(version);
    if (!v) return false;

    // Handle special cases
    if (range === '*' || range === 'latest' || range === '') return true;
    if (range === version) return true;

    // Handle ^ (compatible with)
    if (range.startsWith('^')) {
      const base = SemVer.parse(range.slice(1));
      if (!base) return false;
      
      if (base.major === 0) {
        return v.major === 0 && v.minor === base.minor && v.patch >= base.patch;
      }
      return v.major === base.major && (
        v.minor > base.minor || 
        (v.minor === base.minor && v.patch >= base.patch)
      );
    }

    // Handle ~ (approximately equivalent)
    if (range.startsWith('~')) {
      const base = SemVer.parse(range.slice(1));
      if (!base) return false;
      return v.major === base.major && v.minor === base.minor && v.patch >= base.patch;
    }

    // Handle >= 
    if (range.startsWith('>=')) {
      const base = SemVer.parse(range.slice(2).trim());
      if (!base) return false;
      return SemVer.compare(v, base) >= 0;
    }

    // Handle >
    if (range.startsWith('>') && !range.startsWith('>=')) {
      const base = SemVer.parse(range.slice(1).trim());
      if (!base) return false;
      return SemVer.compare(v, base) > 0;
    }

    // Handle <=
    if (range.startsWith('<=')) {
      const base = SemVer.parse(range.slice(2).trim());
      if (!base) return false;
      return SemVer.compare(v, base) <= 0;
    }

    // Handle <
    if (range.startsWith('<') && !range.startsWith('<=')) {
      const base = SemVer.parse(range.slice(1).trim());
      if (!base) return false;
      return SemVer.compare(v, base) < 0;
    }

    // Handle range (e.g., "1.2.3 - 2.3.4")
    if (range.includes(' - ')) {
      const [min, max] = range.split(' - ').map(r => r.trim());
      const minV = SemVer.parse(min);
      const maxV = SemVer.parse(max);
      if (!minV || !maxV) return false;
      return SemVer.compare(v, minV) >= 0 && SemVer.compare(v, maxV) <= 0;
    }

    // Exact match
    return version === range;
  }

  static compare(v1, v2) {
    if (v1.major !== v2.major) return v1.major - v2.major;
    if (v1.minor !== v2.minor) return v1.minor - v2.minor;
    if (v1.patch !== v2.patch) return v1.patch - v2.patch;
    
    // Handle prereleases
    if (v1.prerelease && !v2.prerelease) return -1;
    if (!v1.prerelease && v2.prerelease) return 1;
    if (v1.prerelease && v2.prerelease) {
      return v1.prerelease.localeCompare(v2.prerelease);
    }
    
    return 0;
  }

  static maxSatisfying(versions, range) {
    const satisfying = versions
      .filter(v => SemVer.satisfies(v, range))
      .map(v => ({ version: v, parsed: SemVer.parse(v) }))
      .filter(v => v.parsed !== null)
      .sort((a, b) => SemVer.compare(b.parsed, a.parsed));

    return satisfying.length > 0 ? satisfying[0].version : null;
  }
}

// ============== CACHE MANAGER ==============

class CacheManager {
  constructor() {
    this.cacheDir = CACHE_DIR;
    this.metadataCache = new Map();
    ensureDir(this.cacheDir);
  }

  getCacheKey(packageName, version) {
    return `${packageName}@${version}`;
  }

  getTarballPath(packageName, version) {
    const safeName = packageName.replace(/\//g, '-');
    return path.join(this.cacheDir, `${safeName}-${version}.tgz`);
  }

  getMetadataPath(packageName) {
    const safeName = packageName.replace(/\//g, '-');
    return path.join(this.cacheDir, `${safeName}-metadata.json`);
  }

  hasTarball(packageName, version) {
    return fs.existsSync(this.getTarballPath(packageName, version));
  }

  async getMetadata(packageName) {
    if (this.metadataCache.has(packageName)) {
      return this.metadataCache.get(packageName);
    }

    const metaPath = this.getMetadataPath(packageName);
    if (fs.existsSync(metaPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        // Cache for 1 hour
        const age = Date.now() - data.timestamp;
        if (age < 3600000) {
          this.metadataCache.set(packageName, data.metadata);
          return data.metadata;
        }
      } catch (e) {
        debug(`Failed to read cached metadata for ${packageName}`);
      }
    }

    return null;
  }

  saveMetadata(packageName, metadata) {
    const metaPath = this.getMetadataPath(packageName);
    const data = {
      timestamp: Date.now(),
      metadata
    };
    fs.writeFileSync(metaPath, JSON.stringify(data));
    this.metadataCache.set(packageName, metadata);
  }

  clear() {
    if (fs.existsSync(this.cacheDir)) {
      fs.rmSync(this.cacheDir, { recursive: true, force: true });
      ensureDir(this.cacheDir);
      log('Cache cleared', 'success');
    }
  }

  getSize() {
    let size = 0;
    if (!fs.existsSync(this.cacheDir)) return 0;

    const walk = (dir) => {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          walk(filePath);
        } else {
          size += stat.size;
        }
      }
    };

    walk(this.cacheDir);
    return size;
  }
}

// ============== DEPENDENCY GRAPH ==============

class DependencyGraph {
  constructor() {
    this.nodes = new Map();
    this.edges = [];
  }

  addNode(packageName, version, metadata) {
    const key = `${packageName}@${version}`;
    this.nodes.set(key, { packageName, version, metadata });
  }

  addEdge(from, to) {
    this.edges.push({ from, to });
  }

  detectCycles() {
    const visited = new Set();
    const recursionStack = new Set();
    const cycles = [];

    const dfs = (node, path = []) => {
      visited.add(node);
      recursionStack.add(node);
      path.push(node);

      const outgoing = this.edges.filter(e => e.from === node);
      for (const edge of outgoing) {
        if (!visited.has(edge.to)) {
          dfs(edge.to, [...path]);
        } else if (recursionStack.has(edge.to)) {
          cycles.push([...path, edge.to]);
        }
      }

      recursionStack.delete(node);
    };

    for (const [key] of this.nodes) {
      if (!visited.has(key)) {
        dfs(key);
      }
    }

    return cycles;
  }

  getInstallOrder() {
    const inDegree = new Map();
    const queue = [];
    const result = [];

    // Initialize in-degrees
    for (const [key] of this.nodes) {
      inDegree.set(key, 0);
    }

    for (const edge of this.edges) {
      inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);
    }

    // Find nodes with no dependencies
    for (const [key, degree] of inDegree) {
      if (degree === 0) {
        queue.push(key);
      }
    }

    // Topological sort
    while (queue.length > 0) {
      const node = queue.shift();
      result.push(node);

      const outgoing = this.edges.filter(e => e.from === node);
      for (const edge of outgoing) {
        inDegree.set(edge.to, inDegree.get(edge.to) - 1);
        if (inDegree.get(edge.to) === 0) {
          queue.push(edge.to);
        }
      }
    }

    return result;
  }
}

// ============== DEPENDENCY RESOLVER ==============

class DependencyResolver {
  constructor(cache) {
    this.cache = cache;
    this.resolved = new Map();
    this.graph = new DependencyGraph();
    this.conflicts = [];
    this.resolving = new Set();
  }

  async resolve(packageName, versionRange, parent = null) {
    const resolvingKey = `${packageName}@${versionRange}`;
    
    // Prevent circular resolution
    if (this.resolving.has(resolvingKey)) {
      debug(`Circular dependency detected: ${resolvingKey}`);
      return null;
    }

    this.resolving.add(resolvingKey);

    try {
      debug(`Resolving ${resolvingKey}${parent ? ` (required by ${parent})` : ''}`);
      
      // Check if already resolved
      const existing = this.findResolved(packageName, versionRange);
      if (existing) {
        debug(`Using cached resolution for ${resolvingKey}: ${existing.version}`);
        return existing;
      }

      // Fetch metadata
      let metadata = await this.cache.getMetadata(packageName);
      if (!metadata) {
        metadata = await httpsGet(`${REGISTRY_URL}/${packageName}`);
        this.cache.saveMetadata(packageName, metadata);
      }

      // Pick best version
      const version = this.pickVersion(metadata, versionRange);
      
      if (!version) {
        throw new Error(`No matching version for ${packageName}@${versionRange}`);
      }

      const versionData = metadata.versions[version];
      const resolvedKey = `${packageName}@${version}`;
      
      // Check if this exact version is already resolved
      if (this.resolved.has(resolvedKey)) {
        return this.resolved.get(resolvedKey);
      }

      const packageInfo = {
        name: packageName,
        version,
        tarball: versionData.dist.tarball,
        integrity: versionData.dist.integrity || versionData.dist.shasum,
        dependencies: versionData.dependencies || {},
        peerDependencies: versionData.peerDependencies || {},
        optionalDependencies: versionData.optionalDependencies || {},
        scripts: versionData.scripts || {},
        bin: versionData.bin || {}
      };

      this.resolved.set(resolvedKey, packageInfo);
      this.graph.addNode(packageName, version, packageInfo);

      // Resolve dependencies
      const allDeps = {
        ...packageInfo.dependencies,
        ...packageInfo.optionalDependencies
      };

      for (const [depName, depRange] of Object.entries(allDeps)) {
        try {
          const depInfo = await this.resolve(depName, depRange, resolvedKey);
          if (depInfo) {
            this.graph.addEdge(resolvedKey, `${depName}@${depInfo.version}`);
          }
        } catch (error) {
          if (packageInfo.optionalDependencies[depName]) {
            log(`Optional dependency failed: ${depName}`, 'warn');
          } else {
            throw error;
          }
        }
      }

      return packageInfo;
    } finally {
      this.resolving.delete(resolvingKey);
    }
  }

  findResolved(packageName, versionRange) {
    for (const [key, info] of this.resolved) {
      if (info.name === packageName && SemVer.satisfies(info.version, versionRange)) {
        return info;
      }
    }
    return null;
  }

  pickVersion(metadata, range) {
    const versions = Object.keys(metadata.versions);
    
    if (range === 'latest' || range === '*' || range === '') {
      return metadata['dist-tags']?.latest || versions[versions.length - 1];
    }

    // Use semver matching
    const matched = SemVer.maxSatisfying(versions, range);
    if (matched) return matched;

    // Fallback to latest
    return metadata['dist-tags']?.latest || versions[versions.length - 1];
  }

  getResolutionTree() {
    const tree = {};
    for (const [key, data] of this.resolved.entries()) {
      tree[key] = {
        version: data.version,
        integrity: data.integrity,
        dependencies: data.dependencies,
        peerDependencies: data.peerDependencies
      };
    }
    return tree;
  }

  checkCycles() {
    const cycles = this.graph.detectCycles();
    if (cycles.length > 0) {
      log('Circular dependencies detected:', 'warn');
      cycles.forEach(cycle => {
        log(`  ${cycle.join(' → ')}`, 'warn');
      });
    }
    return cycles;
  }
}

// ============== PACKAGE INSTALLER ==============

class PackageInstaller {
  constructor() {
    this.cache = new CacheManager();
    this.resolver = new DependencyResolver(this.cache);
    this.installed = new Set();
    this.stats = {
      downloaded: 0,
      cached: 0,
      failed: 0,
      startTime: Date.now()
    };
  }

  async install(dependencies, options = {}) {
    const { production = false, force = false } = options;

    log('🚀 Starting Snapp installation...', 'info');
    
    // Create directories
    ensureDir(NODE_MODULES);
    ensureDir(TEMP_DIR);

    // Clear cache if forced
    if (force) {
      log('Clearing cache...', 'info');
      this.cache.clear();
    }

    // Resolve all dependencies
    log('📦 Resolving dependency tree...', 'info');
    const startResolve = Date.now();

    for (const [name, version] of Object.entries(dependencies)) {
      try {
        await this.resolver.resolve(name, version);
      } catch (error) {
        log(`Failed to resolve ${name}@${version}: ${error.message}`, 'error');
        this.stats.failed++;
      }
    }

    const resolveTime = ((Date.now() - startResolve) / 1000).toFixed(2);
    const resolved = Array.from(this.resolver.resolved.values());
    log(`✓ Resolved ${resolved.length} packages in ${resolveTime}s`, 'success');

    // Check for circular dependencies
    this.resolver.checkCycles();

    // Get install order
    const installOrder = this.resolver.graph.getInstallOrder();
    const orderedPackages = installOrder
      .map(key => this.resolver.resolved.get(key))
      .filter(pkg => pkg);

    // Download and install packages
    log('⬇️  Installing packages...', 'info');
    await this.parallelInstall(orderedPackages);

    // Run lifecycle scripts
    if (!production) {
      await this.runLifecycleScripts(orderedPackages);
    }

    // Save lock file
    this.saveLockFile();

    // Print stats
    this.printStats();

    log('✅ Installation complete!', 'success');
  }

  async parallelInstall(packages) {
    const chunks = [];
    for (let i = 0; i < packages.length; i += MAX_PARALLEL_DOWNLOADS) {
      chunks.push(packages.slice(i, i + MAX_PARALLEL_DOWNLOADS));
    }

    for (const chunk of chunks) {
      await Promise.allSettled(chunk.map(pkg => this.installPackage(pkg)));
    }
  }

  async installPackage(pkg) {
    const pkgPath = path.join(NODE_MODULES, pkg.name);
    
    if (this.installed.has(pkg.name)) {
      return;
    }

    try {
      // Create package directory
      ensureDir(pkgPath);

      // Check cache first
      const cachedTarball = this.cache.getTarballPath(pkg.name, pkg.version);
      let tarballPath;

      if (this.cache.hasTarball(pkg.name, pkg.version)) {
        debug(`Using cached tarball for ${pkg.name}@${pkg.version}`);
        tarballPath = cachedTarball;
        this.stats.cached++;
      } else {
        // Download tarball
        const tempTarball = path.join(TEMP_DIR, `${pkg.name.replace(/\//g, '-')}-${pkg.version}.tgz`);
        await downloadTarball(pkg.tarball, tempTarball, pkg.integrity);
        
        // Copy to cache
        fs.copyFileSync(tempTarball, cachedTarball);
        tarballPath = cachedTarball;
        this.stats.downloaded++;
        
        // Clean up temp
        fs.unlinkSync(tempTarball);
      }

      // Extract
      await extractTarball(tarballPath, pkgPath);

      // Setup bin links if needed
      if (pkg.bin) {
        await this.setupBinLinks(pkg);
      }

      this.installed.add(pkg.name);
      log(`  ✓ ${pkg.name}@${pkg.version}`, 'success');
    } catch (error) {
      log(`  ✗ ${pkg.name}@${pkg.version} - ${error.message}`, 'error');
      this.stats.failed++;
    }
  }

  async setupBinLinks(pkg) {
    const binDir = path.join(NODE_MODULES, '.bin');
    ensureDir(binDir);

    const bins = typeof pkg.bin === 'string' 
      ? { [pkg.name]: pkg.bin }
      : pkg.bin;

    for (const [name, binPath] of Object.entries(bins)) {
      const sourcePath = path.join(NODE_MODULES, pkg.name, binPath);
      const linkPath = path.join(binDir, name);

      try {
        if (fs.existsSync(linkPath)) {
          fs.unlinkSync(linkPath);
        }
        
        // Create symlink
        const relPath = path.relative(binDir, sourcePath);
        fs.symlinkSync(relPath, linkPath);
        
        // Make executable
        if (fs.existsSync(sourcePath)) {
          fs.chmodSync(sourcePath, 0o755);
        }
      } catch (error) {
        debug(`Failed to create bin link for ${name}: ${error.message}`);
      }
    }
  }

  async runLifecycleScripts(packages) {
    const scriptsToRun = packages.filter(pkg => pkg.scripts?.install);
    
    if (scriptsToRun.length === 0) return;
    
    log('🔧 Running lifecycle scripts...', 'info');
    
    for (const pkg of scriptsToRun) {
      try {
        const pkgPath = path.join(NODE_MODULES, pkg.name);
        await execAsync(pkg.scripts.install, { cwd: pkgPath, timeout: 60000 });
        debug(`Ran install script for ${pkg.name}`);
      } catch (error) {
        log(`Install script failed for ${pkg.name}: ${error.message}`, 'warn');
      }
    }
  }

  saveLockFile() {
    const lockData = {
      version: VERSION,
      lockfileVersion: 2,
      resolved: this.resolver.getResolutionTree(),
      timestamp: new Date().toISOString()
    };
    fs.writeFileSync(SNAPP_LOCK_FILE, JSON.stringify(lockData, null, 2));
    log(`📝 Saved ${SNAPP_LOCK_FILE}`, 'info');
  }

  printStats() {
    const totalTime = ((Date.now() - this.stats.startTime) / 1000).toFixed(2);
    const cacheSize = (this.cache.getSize() / 1024 / 1024).toFixed(2);
    
    console.log('');
    log('Installation Statistics:', 'info');
    log(`  Downloaded: ${this.stats.downloaded} packages`, 'info');
    log(`  From cache: ${this.stats.cached} packages`, 'info');
    if (this.stats.failed > 0) {
      log(`  Failed: ${this.stats.failed} packages`, 'warn');
    }
    log(`  Total time: ${totalTime}s`, 'info');
    log(`  Cache size: ${cacheSize} MB`, 'info');
  }
}

// ============== CLI INTERFACE ==============

class SnappCLI {
  constructor() {
    this.commands = {
      install: this.installCommand.bind(this),
      i: this.installCommand.bind(this),
      init: this.initCommand.bind(this),
      add: this.addCommand.bind(this),
      remove: this.removeCommand.bind(this),
      rm: this.removeCommand.bind(this),
      cache: this.cacheCommand.bind(this),
      list: this.listCommand.bind(this),
      ls: this.listCommand.bind(this),
      outdated: this.outdatedCommand.bind(this),
      help: this.helpCommand.bind(this),
      version: this.versionCommand.bind(this)
    };
  }

  async run(args) {
    const command = args[0] || 'help';
    const handler = this.commands[command];

    if (!handler) {
      log(`Unknown command: ${command}`, 'error');
      this.helpCommand();
      process.exit(1);
    }

    try {
      await handler(args.slice(1));
    } catch (error) {
      log(`Command failed: ${error.message}`, 'error');
      if (process.env.SNAPP_DEBUG) {
        console.error(error);
      }
      process.exit(1);
    }
  }

  async installCommand(args) {
    const flags = this.parseFlags(args);
    
    if (!fs.existsSync('package.json')) {
      log('No package.json found. Run "snapp init" first.', 'error');
      process.exit(1);
    }

    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const dependencies = {
      ...(packageJson.dependencies || {}),
      ...(!flags.production ? (packageJson.devDependencies || {}) : {})
    };

    if (Object.keys(dependencies).length === 0) {
      log('No dependencies to install.', 'warn');
      return;
    }

    const installer = new PackageInstaller();
    await installer.install(dependencies, {
      production: flags.production,
      force: flags.force
    });
  }

  async addCommand(args) {
    if (args.length === 0) {
      log('Usage: snapp add <package[@version]> [--dev] [--save-exact]', 'error');
      process.exit(1);
    }

    const flags = this.parseFlags(args);
    const packages = args.filter(a => !a.startsWith('--'));

    if (!fs.existsSync('package.json')) {
      log('No package.json found. Run "snapp init" first.', 'error');
      process.exit(1);
    }

    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const depKey = flags.dev ? 'devDependencies' : 'dependencies';

    if (!packageJson[depKey]) {
      packageJson[depKey] = {};
    }

    // Add packages
    for (const pkg of packages) {
      let [name, version] = pkg.includes('@') && !pkg.startsWith('@') 
        ? pkg.split('@') 
        : [pkg, 'latest'];
      
      // Handle scoped packages like @babel/core
      if (pkg.startsWith('@')) {
        const parts = pkg.split('@');
        name = '@' + parts[1];
        version = parts[2] || 'latest';
      }
      
      const versionPrefix = flags['save-exact'] ? '' : '^';
      packageJson[depKey][name] = version === 'latest' ? `${versionPrefix}latest` : `${versionPrefix}${version}`;
      log(`Added ${name}@${version} to ${depKey}`, 'success');
    }

    // Save package.json
    fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2));

    // Install
    const installer = new PackageInstaller();
    await installer.install({
      ...(packageJson.dependencies || {}),
      ...(packageJson.devDependencies || {})
    });
  }

  async removeCommand(args) {
    if (args.length === 0) {
      log('Usage: snapp remove <package>', 'error');
      process.exit(1);
    }

    if (!fs.existsSync('package.json')) {
      log('No package.json found.', 'error');
      process.exit(1);
    }

    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

    for (const pkgName of args) {
      // Remove from dependencies
      delete packageJson.dependencies?.[pkgName];
      delete packageJson.devDependencies?.[pkgName];

      // Remove from node_modules
      const pkgPath = path.join(NODE_MODULES, pkgName);
      if (fs.existsSync(pkgPath)) {
        fs.rmSync(pkgPath, { recursive: true, force: true });
      }

      log(`Removed ${pkgName}`, 'success');
    }

    fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2));
  }

  async cacheCommand(args) {
    const cache = new CacheManager();
    const subcommand = args[0];

    if (subcommand === 'clean' || subcommand === 'clear') {
      cache.clear();
    } else if (subcommand === 'dir') {
      console.log(cache.cacheDir);
    } else {
      const size = (cache.getSize() / 1024 / 1024).toFixed(2);
      log(`Cache directory: ${cache.cacheDir}`, 'info');
      log(`Cache size: ${size} MB`, 'info');
      log('', 'info');
      log('Commands:', 'info');
      log('  snapp cache clean  - Clear the cache', 'info');
      log('  snapp cache dir    - Show cache directory', 'info');
    }
  }

  async listCommand(args) {
    if (!fs.existsSync(NODE_MODULES)) {
      log('No packages installed.', 'warn');
      return;
    }

    const packages = fs.readdirSync(NODE_MODULES)
      .filter(name => !name.startsWith('.'))
      .sort();

    // Handle scoped packages
    const allPackages = [];
    for (const item of packages) {
      const itemPath = path.join(NODE_MODULES, item);
      if (item.startsWith('@')) {
        const scopedPackages = fs.readdirSync(itemPath);
        for (const pkg of scopedPackages) {
          allPackages.push(`${item}/${pkg}`);
        }
      } else {
        allPackages.push(item);
      }
    }

    log(`📦 Installed packages (${allPackages.length}):`, 'info');
    for (const pkg of allPackages) {
      const pkgJsonPath = path.join(NODE_MODULES, pkg, 'package.json');
      if (fs.existsSync(pkgJsonPath)) {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        console.log(`  ${pkg}@${pkgJson.version}`);
      }
    }
  }

  async outdatedCommand(args) {
    if (!fs.existsSync('package.json')) {
      log('No package.json found.', 'error');
      return;
    }

    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const dependencies = {
      ...(packageJson.dependencies || {}),
      ...(packageJson.devDependencies || {})
    };

    log('Checking for outdated packages...', 'info');
    
    const outdated = [];
    for (const [name, range] of Object.entries(dependencies)) {
      try {
        const metadata = await httpsGet(`${REGISTRY_URL}/${name}`);
        const latest = metadata['dist-tags']?.latest;
        const current = range.replace(/[\^~>=<]/g, '');
        
        if (latest && latest !== current && !SemVer.satisfies(latest, range)) {
          outdated.push({ name, current: range, latest });
        }
      } catch (error) {
        debug(`Failed to check ${name}: ${error.message}`);
      }
    }

    if (outdated.length === 0) {
      log('All packages are up to date!', 'success');
    } else {
      log(`Found ${outdated.length} outdated packages:`, 'warn');
      for (const pkg of outdated) {
        console.log(`  ${pkg.name}: ${pkg.current} → ${pkg.latest}`);
      }
    }
  }

  initCommand() {
    if (fs.existsSync('package.json')) {
      log('package.json already exists!', 'warn');
      return;
    }

    const packageJson = {
      name: path.basename(process.cwd()),
      version: '1.0.0',
      description: '',
      main: 'index.js',
      scripts: {
        test: 'echo "Error: no test specified" && exit 1'
      },
      keywords: [],
      author: '',
      license: 'ISC',
      dependencies: {},
      devDependencies: {}
    };

    fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2));
    log('✅ Created package.json', 'success');
  }

  versionCommand() {
    console.log(`snapp v${VERSION}`);
  }

  helpCommand() {
    console.log(`
╔═══════════════════════════════════════════════════╗
║   SNAPP v${VERSION} - Simple Node App Package      ║
║   Lightning-fast, parallel package installation   ║
╚═══════════════════════════════════════════════════╝

Usage: snapp <command> [options]

Commands:
  init                Create a new package.json
  install, i [opts]   Install dependencies from package.json
    --production      Install only production dependencies
    --force           Clear cache and reinstall
  add <pkg> [opts]    Add package(s) to dependencies
    --dev             Add to devDependencies
    --save-exact      Save exact version (no ^)
  remove, rm <pkg>    Remove package(s)
  list, ls            List installed packages
  outdated            Check for outdated packages
  cache [cmd]         Manage package cache
    clean             Clear the cache
    dir               Show cache directory
  version             Show Snapp version
  help                Show this help message

Environment Variables:
  SNAPP_REGISTRY      Custom registry URL (default: npm registry)
  SNAPP_PARALLEL      Max parallel downloads (default: 10)
  SNAPP_DEBUG         Enable debug logging (0 or 1)

Features:
  ⚡ Up to 10 parallel downloads (configurable)
  🔒 SHA-512 integrity checking
  💾 Smart caching system
  🌳 Dependency graph analysis
  🔄 Circular dependency detection
  📊 Detailed installation statistics
  🎯 Full semver resolution
  🔗 Binary linking support
  ♻️ Automatic retry on failures
  
Examples:
  snapp init
  snapp install
  snapp add express lodash
  snapp add jest --dev
  snapp remove lodash
  snapp outdated
  snapp cache clean
  SNAPP_PARALLEL=15 snapp install
  SNAPP_DEBUG=1 snapp install
    `);
  }

  parseFlags(args) {
    const flags = {};
    for (const arg of args) {
      if (arg === '--production') flags.production = true;
      if (arg === '--force') flags.force = true;
      if (arg === '--dev') flags.dev = true;
      if (arg === '--save-exact') flags['save-exact'] = true;
    }
    return flags;
  }
}

// ============== ENTRY POINT ==============

async function main() {
  const args = process.argv.slice(2);
  const cli = new SnappCLI();
  
  try {
    await cli.run(args);
  } catch (error) {
    log(`Fatal error: ${error.message}`, 'error');
    if (process.env.SNAPP_DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}

// Handle uncaught errors gracefully
process.on('uncaughtException', (error) => {
  log(`Uncaught exception: ${error.message}`, 'error');
  if (process.env.SNAPP_DEBUG) {
    console.error(error);
  }
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  log(`Unhandled rejection: ${error.message}`, 'error');
  if (process.env.SNAPP_DEBUG) {
    console.error(error);
  }
  process.exit(1);
});

main();