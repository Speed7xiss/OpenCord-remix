import { z } from 'zod';

export const usernameSchema = z.string().trim().min(3).max(24).regex(/^[a-zA-Z0-9_.-]+$/);
export const passwordSchema = z.string().min(8).max(128);
export const displayNameSchema = z.string().trim().min(1).max(32);
export const messageSchema = z.string().trim().min(1).max(4000);
export const serverNameSchema = z.string().trim().min(1).max(60);
export const channelNameSchema = z.string().trim().min(1).max(48).regex(/^[\p{L}\p{N}_ -]+$/u);
export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export function parseId(value: unknown) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}
