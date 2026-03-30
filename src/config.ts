import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Config, CategoryCache } from './types';

const CONFIG_DIR = path.join(os.homedir(), '.ynab-cli');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const CATEGORIES_FILE = path.join(CONFIG_DIR, 'categories.json');

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { mode: 0o700, recursive: true });
  }
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_FILE);
}

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(
      'No configuration found. Run `ynab setup` to configure your YNAB token and budget.'
    );
  }
  const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
  return JSON.parse(raw) as Config;
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function loadCategoryCache(): CategoryCache | null {
  if (!fs.existsSync(CATEGORIES_FILE)) return null;
  try {
    const raw = fs.readFileSync(CATEGORIES_FILE, 'utf-8');
    return JSON.parse(raw) as CategoryCache;
  } catch {
    return null;
  }
}

export function saveCategoryCache(cache: CategoryCache): void {
  ensureConfigDir();
  fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

export const CONFIG_DIR_PATH = CONFIG_DIR;
export const CATEGORIES_FILE_PATH = CATEGORIES_FILE;
