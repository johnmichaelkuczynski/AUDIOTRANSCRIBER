import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export const SESSION_COOKIE = "session";

export interface SessionUser {
  uid: number;
  email: string;
  name?: string | null;
  picture?: string | null;
}

export interface AuthedRequest extends Request {
  user?: SessionUser;
}

export function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is not set");
  }
  return secret;
}

export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): void {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const payload = jwt.verify(token, getSessionSecret()) as jwt.JwtPayload & SessionUser;
    req.user = {
      uid: payload.uid,
      email: payload.email,
      name: payload.name ?? null,
      picture: payload.picture ?? null,
    };
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
}
