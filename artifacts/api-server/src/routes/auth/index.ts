import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { eq } from "drizzle-orm";
import { db, usersTable, loginEventsTable } from "@workspace/db";
import {
  requireAuth,
  getSessionSecret,
  SESSION_COOKIE,
  type AuthedRequest,
} from "../../middlewares/requireAuth";

const router: IRouter = Router();

const STATE_COOKIE = "oauth_state";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function getGoogleClientId(): string {
  const id = process.env.GOOGLE_CLIENT_ID;
  if (!id) throw new Error("GOOGLE_CLIENT_ID is not set");
  return id;
}

function getGoogleClientSecret(): string {
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!secret) throw new Error("GOOGLE_CLIENT_SECRET is not set");
  return secret;
}

function isSecure(req: Request): boolean {
  return req.protocol === "https";
}

function redirectUri(req: Request): string {
  return `${req.protocol}://${req.get("host")}/api/auth/google/callback`;
}

router.get("/auth/google", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecure(req),
    maxAge: 10 * 60 * 1000,
    path: "/",
  });
  const params = new URLSearchParams({
    client_id: getGoogleClientId(),
    redirect_uri: redirectUri(req),
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

router.get("/auth/google/callback", async (req, res): Promise<void> => {
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;
  const savedState = req.cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, { path: "/" });

  if (!code || !state || !savedState || state !== savedState) {
    res.status(400).send("Invalid OAuth state. Please try signing in again.");
    return;
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: getGoogleClientId(),
        client_secret: getGoogleClientSecret(),
        redirect_uri: redirectUri(req),
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) {
      const detail = await tokenRes.text();
      req.log.error({ status: tokenRes.status, detail }, "Google token exchange failed");
      res.status(502).send("Google sign-in failed. Please try again.");
      return;
    }
    const tokens = (await tokenRes.json()) as { id_token?: string };
    if (!tokens.id_token) {
      res.status(502).send("Google sign-in failed: no identity token returned.");
      return;
    }

    const client = new OAuth2Client(getGoogleClientId());
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: getGoogleClientId(),
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) {
      res.status(400).send("Google account is missing an email address.");
      return;
    }

    const [existing] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.googleId, payload.sub));

    let user = existing;
    if (user) {
      [user] = await db
        .update(usersTable)
        .set({
          email: payload.email,
          name: payload.name ?? null,
          picture: payload.picture ?? null,
        })
        .where(eq(usersTable.id, user.id))
        .returning();
    } else {
      [user] = await db
        .insert(usersTable)
        .values({
          googleId: payload.sub,
          email: payload.email,
          name: payload.name ?? null,
          picture: payload.picture ?? null,
        })
        .returning();
    }

    await db.insert(loginEventsTable).values({
      userId: user.id,
      email: user.email,
      provider: "google",
    });

    const token = jwt.sign(
      { uid: user.id, email: user.email, name: user.name, picture: user.picture },
      getSessionSecret(),
      { expiresIn: "30d" },
    );
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: isSecure(req),
      maxAge: SESSION_MAX_AGE_MS,
      path: "/",
    });
    res.redirect("/app");
  } catch (err) {
    req.log.error({ err }, "Google OAuth callback failed");
    res.status(500).send("Sign-in failed. Please try again.");
  }
});

router.get("/auth/me", requireAuth, (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  res.json({
    id: user.uid,
    email: user.email,
    name: user.name ?? null,
    picture: user.picture ?? null,
  });
});

router.post("/auth/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.sendStatus(204);
});

export default router;
