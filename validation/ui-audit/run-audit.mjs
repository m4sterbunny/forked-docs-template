#!/usr/bin/env node

/**
 * UI Audit - Main Orchestrator
 * 
 * Runs UI documentation coverage audits based on YAML configuration.
 * Supports multiple target repositories (docs and source).
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration file location
const CONFIG_FILE = resolve(__dirname, 'ui-audit.config.yaml');
const CONFIG_EXAMPLE = resolve(__dirname, 'ui-audit.config.example.yaml');

/**
 * Load and parse YAML configuration
 */
function loadConfig() {
  if (!existsSync(CONFIG_FILE)) {
    console.error('❌ Configuration file not found!');
    console.error(`\nExpected location: ${CONFIG_FILE}`);
    console.error(`\nPlease create it from the example:`);
    console.error(`  cp ui-audit.config.example.yaml ui-audit.config.yaml`);
    console.error(`  # Edit ui-audit.config.yaml with your local paths\n`);
    process.exit(1);
  }

  try {
    const configContent = readFileSync(CONFIG_FILE, 'utf8');
    return yaml.load(configContent);
  } catch (error) {
    console.error('❌ Failed to parse configuration file:', error.message);
    process.exit(1);
  }
}

/**
 * Validate that target repositories exist and are accessible
 */
function validateTargets(config) {
  if (!config.targets || config.targets.length === 0) {
    console.error('❌ No targets defined in configuration');
    process.exit(1);
  }

  const enabledTargets = config.targets.filter(t => t.enabled !== false);
  
  if (enabledTargets.length === 0) {
    console.warn('⚠️  No enabled targets found in configuration');
    return [];
  }

  for (const target of enabledTargets) {
    if (!target.path) {
      console.error(`❌ Target "${target.name}" missing path`);
      process.exit(1);
    }

    if (!existsSync(target.path)) {
      console.error(`❌ Target "${target.name}" path does not exist: ${target.path}`);
      process.exit(1);
    }
  }

  return enabledTargets;
}

/**
 * Run a single audit command
 */
async function runAudit(command, args, description) {
  console.log(`\n📋 Running: ${description}`);
  console.log(`   Command: ${command} ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: __dirname,
      stdio: 'inherit',
      shell: true
    });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log(`✅ ${description} completed successfully`);
        resolve();
      } else {
        console.error(`❌ ${description} failed with code ${code}`);
        reject(new Error(`Audit failed: ${description}`));
      }
    });

    proc.on('error', (error) => {
      console.error(`❌ Failed to start ${description}:`, error.message);
      reject(error);
    });
  });
}

/**
 * Main audit runner
 */
async function main() {
  console.log('🔍 UI Audit - Standalone Validation Tool\n');
  
  // Load configuration
  console.log('📖 Loading configuration...');
  const config = loadConfig();
  
  // Validate targets
  console.log('✓ Validating targets...');
  const targets = validateTargets(config);
  console.log(`✓ Found ${targets.length} enabled target(s):`);
  targets.forEach(t => {
    console.log(`   - ${t.name} (${t.type}) @ ${t.path}`);
  });

  // Check which audits are enabled
  const audits = config.audit || {};
  const enabledAudits = [];
  
  if (audits.demo_app?.enabled !== false) {
    enabledAudits.push({ name: 'demo-app', script: 'audit:demo', description: 'Component Audit' });
  }
  
  if (audits.hooks?.enabled !== false) {
    enabledAudits.push({ name: 'hooks', script: 'audit:hooks', description: 'Hooks Audit' });
  }
  
  if (audits.ui_core?.enabled !== false) {
    enabledAudits.push({ name: 'ui-core', script: 'audit:ui-core', description: 'UI Core Utilities Audit' });
  }

  if (enabledAudits.length === 0) {
    console.warn('⚠️  No audits enabled in configuration');
    return;
  }

  console.log(`\n✓ Found ${enabledAudits.length} enabled audit(s):`);
  enabledAudits.forEach(a => {
    console.log(`   - ${a.description}`);
  });

  // Run audits sequentially
  console.log('\n' + '='.repeat(60));
  console.log('Running Audits');
  console.log('='.repeat(60));

  const results = [];
  
  for (const audit of enabledAudits) {
    try {
      await runAudit('npm', ['run', audit.script], audit.description);
      results.push({ audit: audit.name, status: 'success' });
    } catch (error) {
      results.push({ audit: audit.name, status: 'failed', error: error.message });
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Audit Summary');
  console.log('='.repeat(60));
  
  const successful = results.filter(r => r.status === 'success').length;
  const failed = results.filter(r => r.status === 'failed').length;
  
  results.forEach(r => {
    const icon = r.status === 'success' ? '✅' : '❌';
    console.log(`${icon} ${r.audit}: ${r.status}`);
  });
  
  console.log(`\nTotal: ${successful} successful, ${failed} failed`);

  // Run verification if enabled
  if (config.verify?.enabled !== false) {
    console.log('\n' + '='.repeat(60));
    console.log('Running Verification');
    console.log('='.repeat(60));
    
    try {
      await runAudit('npm', ['run', 'verify'], 'Audit Verification');
    } catch (error) {
      console.warn('⚠️  Verification failed (non-fatal)');
    }
  }

  // Exit with appropriate code
  if (failed > 0) {
    console.error(`\n❌ ${failed} audit(s) failed`);
    process.exit(1);
  } else {
    console.log('\n✅ All audits completed successfully!');
  }
}

// Run main
main().catch((error) => {
  console.error('\n❌ Fatal error:', error.message);
  process.exit(1);
});
