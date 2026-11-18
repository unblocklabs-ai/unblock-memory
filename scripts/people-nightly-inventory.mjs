#!/usr/bin/env node
// Portable operator entry point. Host configuration owns identities, paths and timezone.
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (!args.includes('--agent')) throw new Error('Usage: people-nightly-inventory.mjs --agent ID [--kind nightly|weekly] [--date YYYY-MM-DD]');
if (args.includes('--dry-run')) throw new Error('Use the operator inventory command; it writes private resumable review state, never people preferences.');
const result = spawnSync('openclaw', ['memory-people-learning', 'inventory', ...args], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
