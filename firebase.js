/**
 * Legacy Firebase facade.
 * The application has been fully migrated to PocketBase domain APIs (Sprint 6).
 * This module exports no-op stubs to avoid runtime crashes if referenced.
 */

export const isStorageEnabled = false;
export const auth = null;
export const db = null;
export const rtdb = null;
export const storage = null;
export const functions = null;
export const googleProvider = null;

export default null;