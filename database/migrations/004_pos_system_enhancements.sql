-- Migration 004: POS system enhancements & custom theme setting
-- Non-destructive: adds custom_theme column to settings table

ALTER TABLE settings ADD COLUMN custom_theme TEXT NOT NULL DEFAULT 'dark';
