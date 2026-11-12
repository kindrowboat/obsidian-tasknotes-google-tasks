import { Platform, requestUrl } from "obsidian";

/**
 * Google OAuth 2.0 for installed apps: authorization code + PKCE with a
 * loopback redirect (http://127.0.0.1:<port>). Requires the desktop app,
 * because it has to open a short-lived local HTTP server. Once a refresh token
 * exists, token refresh works on every platform.
 */

export const TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export interface OAuthClient {
	clientId: string;
	clientSecret: string;
}

export interface TokenSet {
	accessToken: string;
	refreshToken: string;
	/** Epoch ms after which the access token should be treated as expired. */
	expiresAt: number;
}

function base64Url(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return base64Url(bytes);
}

async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return base64Url(new Uint8Array(digest));
}

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
	const res = await requestUrl({
		url,
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		body: new URLSearchParams(body).toString(),
		throw: false,
	});
	if (res.status >= 400) {
		const detail = typeof res.json === "object" && res.json ? JSON.stringify(res.json) : res.text;
		throw new Error(`Google token endpoint returned ${res.status}: ${detail}`);
	}
	return res.json as Record<string, unknown>;
}

/** Run the interactive browser sign-in and return a fresh token set. */
export async function signIn(client: OAuthClient): Promise<TokenSet> {
	if (!Platform.isDesktopApp) {
		throw new Error("Signing in to Google requires the Obsidian desktop app. Sign in there; the tokens sync with your plugin settings.");
	}
	if (!client.clientId) throw new Error("Set a Google OAuth client ID in the plugin settings first.");

	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const http: typeof import("http") = require("http");
	const verifier = randomString(48);
	const challenge = await pkceChallenge(verifier);
	const state = randomString(16);

	const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
		let redirectUri = "";
		const server = http.createServer((req, res) => {
			const url = new URL(req.url ?? "/", redirectUri || "http://127.0.0.1");
			const err = url.searchParams.get("error");
			const gotCode = url.searchParams.get("code");
			const gotState = url.searchParams.get("state");
			if (!err && !gotCode) {
				res.writeHead(404).end();
				return;
			}
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			const ok = !err && gotState === state && gotCode;
			res.end(
				`<!doctype html><meta charset="utf-8"><title>TaskNotes Google Tasks</title>` +
					`<body style="font-family:system-ui;padding:2rem">` +
					(ok ? "<h1>Signed in.</h1><p>You can close this tab and return to Obsidian.</p>"
						: `<h1>Sign-in failed.</h1><p>${err ?? "State mismatch"}</p>`) +
					`</body>`,
			);
			clearTimeout(timer);
			server.close();
			if (err) reject(new Error(`Google sign-in failed: ${err}`));
			else if (gotState !== state) reject(new Error("Google sign-in failed: state mismatch."));
			else resolve({ code: gotCode as string, redirectUri });
		});
		const timer = setTimeout(() => {
			server.close();
			reject(new Error("Google sign-in timed out."));
		}, LOGIN_TIMEOUT_MS);
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			redirectUri = `http://127.0.0.1:${port}`;
			const params = new URLSearchParams({
				client_id: client.clientId,
				redirect_uri: redirectUri,
				response_type: "code",
				scope: TASKS_SCOPE,
				code_challenge: challenge,
				code_challenge_method: "S256",
				access_type: "offline",
				prompt: "consent",
				state,
			});
			window.open(`${AUTH_URL}?${params.toString()}`);
		});
	});

	const json = await postForm(TOKEN_URL, {
		client_id: client.clientId,
		client_secret: client.clientSecret,
		code,
		code_verifier: verifier,
		redirect_uri: redirectUri,
		grant_type: "authorization_code",
	});
	const refreshToken = json.refresh_token as string | undefined;
	if (!refreshToken) throw new Error("Google did not return a refresh token. Remove the app's access at myaccount.google.com/permissions and sign in again.");
	return {
		accessToken: json.access_token as string,
		refreshToken,
		expiresAt: Date.now() + ((json.expires_in as number) - 60) * 1000,
	};
}

export async function refresh(client: OAuthClient, tokens: TokenSet): Promise<TokenSet> {
	const json = await postForm(TOKEN_URL, {
		client_id: client.clientId,
		client_secret: client.clientSecret,
		refresh_token: tokens.refreshToken,
		grant_type: "refresh_token",
	});
	return {
		accessToken: json.access_token as string,
		// Google normally keeps the refresh token, but may rotate it.
		refreshToken: (json.refresh_token as string | undefined) ?? tokens.refreshToken,
		expiresAt: Date.now() + ((json.expires_in as number) - 60) * 1000,
	};
}

export async function revoke(tokens: TokenSet): Promise<void> {
	await requestUrl({
		url: `${REVOKE_URL}?token=${encodeURIComponent(tokens.refreshToken)}`,
		method: "POST",
		throw: false,
	});
}
