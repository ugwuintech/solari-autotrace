import { SolariError, type BrowserSession, type LaunchOptions, type Solari } from "@solarisdk/browser";
import type { RecoveryRecorder } from "../types/recovery.js";

// Long enough to outlast a brief Solari API hiccup; the SDK's own retries are spaced much closer.
const LAUNCH_RETRY_DELAY_MS = 10_000;

/**
 * True when Solari could not create a session after the SDK's own short retries.
 * The SDK's launch({ retries }) only covers failures after a session exists, so session creation
 * is the gap this module fills. Auth and plan errors are not "exhausted" and fail immediately.
 */
export function isTransientSessionFailure(error: unknown): boolean {
  return error instanceof SolariError && /exhausted \d+ attempts/.test(error.message);
}

/**
 * Launch a Solari browser, waiting once and trying again when session creation is temporarily
 * unavailable. The recovery is reported so the investigation shows the retry instead of hiding it.
 */
export async function launchBrowser(
  solari: Solari,
  options: LaunchOptions,
  purpose: string,
  onRecovery?: RecoveryRecorder,
  delayMs: number = LAUNCH_RETRY_DELAY_MS
): Promise<BrowserSession> {
  try {
    return await solari.launch(options);
  } catch (error) {
    if (!isTransientSessionFailure(error)) {
      throw error;
    }

    const reason = error instanceof Error ? error.message : String(error);
    console.log(`Solari session creation failed for ${purpose}; retrying once in ${delayMs / 1000}s: ${reason}`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    const browser = await solari.launch(options);
    onRecovery?.({
      step: purpose,
      failure: `Solari could not create a browser session: ${reason}`,
      action: `waited ${delayMs / 1000}s and launched a new session successfully`,
    });
    return browser;
  }
}
