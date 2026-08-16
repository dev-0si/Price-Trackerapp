-- Migration: initial schema
-- Creates the three core tables for the price tracker

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('crypto', 'fx')),
  high_target REAL,
  low_target REAL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alert_state (
  symbol TEXT PRIMARY KEY,
  fire_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'triggered')),
  last_fired_at TEXT
);

CREATE TABLE IF NOT EXISTS feed_status (
  feed_name TEXT PRIMARY KEY,
  current_status TEXT NOT NULL DEFAULT 'primary' CHECK (current_status IN ('primary', 'fallback', 'down')),
  last_checked TEXT NOT NULL DEFAULT (datetime('now'))
);
